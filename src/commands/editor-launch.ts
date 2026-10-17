import type { ChildProcess } from 'node:child_process';
import { listAccounts } from '../accounts/registry.js';
import { getActive, setActive } from '../state/active.js';
import { probeAll } from '../health/prober.js';
import { select } from '../selector/selector.js';
import { launchWatched, spawnWatched, type WatchedResult } from '../launcher/launcher.js';
import {
  loadLedger,
  updateLedger,
  markCapped,
  cappedNames,
  accountCapEnd,
  limitOnLedger,
} from '../ledger/ledger.js';
import { hasWorkingLogin } from '../accounts/account-login.js';
import { signedInAndNotRejected } from '../health/signed-in.js';
import { appendEvent } from '../events/log.js';
import { ensureEditorReady } from './editor-ready.js';
import { configHome } from '../config/paths.js';
import {
  confirmCap,
  refusalConfirmed,
  refusalLimitEnd,
  usageAnswer,
  type CapDecision,
} from '../usage/confirm-cap.js';
import { judgeRefusal, limitNamed, type RecordedRefusal, type WriterLookup } from '../session/refused-turn.js';
import { createRecordWatch, type RecordWatch } from '../session/record-watch.js';
import { createCheckBackoff } from '../session/check-backoff.js';
import type { Refusal } from '../session/transcript.js';
import { conversationIdIn, forksConversation, wantsExistingConversation } from '../launcher/conversation.js';
import { exitCodeForSignal, type SignalSource } from '../launcher/interruption.js';
import { normalizeModel } from '../usage/model-preference.js';
import { getClaude, type CliContext } from '../context.js';
import type { Account } from '../accounts/registry.schema.js';

/** Pick the account to launch on: active if usable, else the healthiest eligible. */
async function pickAccount(context: CliContext): Promise<Account | undefined> {
  const accounts = listAccounts(context.ctx);
  const capped = cappedNames(loadLedger(context.ctx), Date.now());
  const active = getActive(context.ctx) ?? undefined;

  const fast = accounts.find(
    (a) => a.name === active && a.enabled && !capped.has(a.name) && hasWorkingLogin(a.dir, context.ctx),
  );
  if (fast) return fast;

  const picked = await selectHealthy(context, accounts, capped, active);
  if (picked) setActive(picked.name, context.ctx);
  return picked;
}

/** How often an editor's Claude's records are read while it runs: as often as a terminal session's. */
const FOLLOW_MS = 1_200;
/** The longest the end of a run waits for a check still under way; the usage check gives up sooner. */
const CHECK_WAIT_MS = 12_000;
/**
 * How long ccx-claude goes on once the extension asks it to end. The
 * extension (2.1.302, ProcessTransport.close) closes Claude's input, sends
 * SIGTERM 2 s later to a wrapper still running, and SIGKILL 5 s after that.
 */
const ENDING_MS = 4_000;
/** Among refusals held back: the whole account's limit, and one ccx cannot name. A model's goes by its name. */
const WHOLE_ACCOUNT = 'the whole account';
const UNNAMED = 'a limit ccx cannot name';

/** Wait for `promise` to settle, or for `ms` to pass, whichever is first. */
function within(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}

/** A refused turn as read, with the conversation whose record it was read from. */
interface Seen {
  refusal: Refusal;
  conversation: string | null;
}

interface EditorWatch {
  /** Told of the Claude just started; following begins. */
  started(child: ChildProcess): void;
  /**
   * The wrapper is asked to end: Claude is told to end as well while it runs,
   * and refusals held back are asked about now.
   */
  ending(): void;
  /** After Claude has exited: its record's last news, the checks still due, then its standard error. */
  finished(result: WatchedResult): Promise<void>;
}

/**
 * Following one editor launch's Claude, and acting on the limits it meets.
 *
 * One Claude answers every turn of an editor chat and ends only when the chat
 * closes, long after a refusal stops speaking for the turn in front of it
 * (session/refused-turn), and what it prints goes to the editor, not through
 * ccx. So its refused turns are read from Claude's own records while it runs,
 * by the watch a terminal session uses (session/record-watch): the
 * conversation from the per-process record Claude keeps in the account's
 * folder, followed when the process moves to another (a /clear), and that
 * conversation's record as it grows. Its standard error is still read once it
 * has ended, for what only that shows.
 *
 * However a limit was seen, one check decides it (`act`): the account's own
 * usage, with Claude's record of the refused turn standing in when that cannot
 * answer, judged by the same rules as a terminal session's. A limit the ledger
 * already holds for this account is neither asked about nor recorded again,
 * and a check that confirms nothing holds the next ones back as a terminal
 * session's does (session/check-backoff).
 */
function watchEditorLaunch(context: CliContext, chosen: Account, claudeArgs: string[]): EditorWatch {
  const home = configHome(context.ctx);
  const startsNew = !wantsExistingConversation(claudeArgs);
  // An existing chat comes with `--resume=<id>`, and the extension starts its
  // Claude to send the turn the person just wrote, which can be refused before
  // the per-process record is first read.
  const resumes = startsNew || forksConversation(claudeArgs) ? null : conversationIdIn(claudeArgs);
  // An editor's Claude keeps its per-process record in the account's folder.
  const writers: WriterLookup = {
    sessionDir: null,
    configDirs: () => listAccounts(context.ctx).map((a) => a.dir),
    ctx: context.ctx,
    ...(context.isClaudeProcess ? { isClaude: context.isClaudeProcess } : {}),
  };
  /**
   * Whether the ledger, which every session writes, holds a limit of this
   * scope for the account that still holds. An editor's Claude outlives a
   * limit's reset, and meeting it again after that is news.
   */
  const covered = (model: string | undefined): boolean =>
    limitOnLedger(loadLedger(context.ctx), chosen.name, model, Date.now());
  const backoff = createCheckBackoff(context.refuteBackoffMs);
  let watch: RecordWatch | null = null;
  let child: ChildProcess | null = null;
  let timer: NodeJS.Timeout | null = null;
  /** The check under way for a refused turn. */
  let checking: Promise<void> | null = null;
  /**
   * Refused turns waiting to be asked about, the newest of each limit. One
   * newest of all would let a refusal for one model, read later, push out the
   * whole account's, which is the only one that keeps the next chat off it.
   */
  const held = new Map<string, Seen>();
  /** Claude is ending or has ended: what is held is asked about now, whatever the back-off says. */
  let ending = false;

  const scopeOf = (refusal: Refusal): string => {
    const named = limitNamed(refusal.limitType);
    if (named === null) return UNNAMED;
    return named.model === undefined ? WHOLE_ACCOUNT : normalizeModel(named.model);
  };
  const hold = (seen: Seen): void => {
    const scope = scopeOf(seen.refusal);
    held.delete(scope);
    held.set(scope, seen);
  };
  /** The next refusal held back, the whole account's first, since it takes in every other. */
  const takeHeld = (): Seen | null => {
    const scope = held.has(WHOLE_ACCOUNT) ? WHOLE_ACCOUNT : [...held.keys()][0];
    if (scope === undefined) return null;
    const seen = held.get(scope) ?? null;
    held.delete(scope);
    return seen;
  };

  // The injected verdict when a test supplies one, exactly as the session path
  // does; otherwise the account's own credential, which is the one this Claude
  // runs on. Nothing changes the login under an editor's Claude: a move changes
  // which account the next chat starts on.
  const decide = async (text: string, recorded?: RecordedRefusal): Promise<CapDecision> => {
    if (context.verifyCap) return { limited: (await context.verifyCap(text)) === 'limited' };
    return confirmCap(chosen.dir, text, {
      ...(context.capProbe ? { probe: context.capProbe } : {}),
      ...(recorded ? { refusal: judgeRefusal(recorded, writers, () => 0) } : {}),
    });
  };

  /**
   * Text only TRIGGERS this; the account's own usage decides, exactly as in
   * every other cap-recording path. This one once wrote the cap straight from
   * the classification, so any limit-looking text in an editor session, a
   * replayed cap message or a conversation merely discussing rate limits,
   * benched a healthy account for the default five hours AND moved the
   * operator's active account off it.
   */
  const act = async (text: string, reason: string, recorded?: RecordedRefusal): Promise<void> => {
    const decision = await decide(text, recorded);
    const seenIn = recorded ? 'record' : 'stderr';
    const seen = recorded ? 'Claude recorded a refused turn in the editor' : 'limit text in the editor';
    if (!decision.limited) {
      backoff.pause(Date.now());
      appendEvent(
        home,
        decision.unanswered
          ? `${seen}, but not moving the editor yet: the usage check could not answer (${usageAnswer(decision)}), ` +
              `and ${decision.refusalWhy ?? 'Claude has not recorded the turn as refused'}`
          : `${seen}, but "${chosen.name}" shows no spent window; nothing recorded`,
        Date.now(),
        { kind: 'cap-verify', data: { account: chosen.name, seenIn } },
      );
      return;
    }
    // Asked again after the check: it may have been recorded meanwhile, here or elsewhere.
    if (covered(decision.model)) return;
    if (decision.byRefusal) {
      appendEvent(home, `in the editor, ${refusalConfirmed(decision)}`, Date.now(), {
        kind: 'cap-verify',
        data: { account: chosen.name, seenIn, confirmedBy: 'refusal' },
      });
    }
    const now = Date.now();
    updateLedger(context.ctx, (ledger) =>
      markCapped(ledger, {
        account: chosen.name,
        now,
        // The VERIFIED window only. The classification's reset time is parsed out
        // of the rendered text, and text that has just been refuted as a verdict
        // is no better as a duration: a replayed message announcing a reset days
        // away would bench the account for days on a limit whose real window
        // nobody reported. A limit the record proved lasts as the refusal says.
        //
        // The configured backoff stays, though, because the alternative is worse
        // than it looks: markCapped turns a null reset into a null capUntil, and
        // isActive treats null as active forever, so a verified limit that came
        // with no window would bench the account PERMANENTLY. A bounded guess
        // beats an unbounded one.
        resetAt:
          (decision.byRefusal
            ? refusalLimitEnd(decision, () => accountCapEnd(ledger, chosen.name, now))
            : decision.resetAt) ?? null,
        backoffMinutes: context.config.rotation.defaultBackoffMinutes,
        reason,
        // A model-scoped limit leaves the account working on everything else.
        ...(decision.model ? { model: decision.model } : {}),
      }),
    );
    appendEvent(home, `${chosen.name} hit its limit (editor)`, Date.now());
    const next = await selectHealthy(
      context,
      listAccounts(context.ctx),
      cappedNames(loadLedger(context.ctx), Date.now()),
      undefined,
    );
    if (next) {
      setActive(next.name, context.ctx);
      appendEvent(home, `next editor chat will use ${next.name}`, Date.now());
    }
  };

  const refused = (seen: Seen): void => {
    // Claude refuses every turn the person tries until a limit resets, and each
    // check spends the usage endpoint's budget, which every session on the
    // machine shares: a limit the ledger holds is not asked about again.
    if (!watch || covered(limitNamed(seen.refusal.limitType)?.model)) return;
    if (checking || (!ending && backoff.paused(Date.now()))) {
      hold(seen);
      return;
    }
    // Judged as things are when it is asked about, so a prompt typed while it
    // waited counts against it, but on the conversation it was read from.
    const recorded = { ...watch.recorded(seen.refusal, child?.pid ?? null), conversation: seen.conversation };
    checking = act(seen.refusal.text, seen.refusal.apiError ?? seen.refusal.error, recorded)
      .catch(() => {
        /* a check that fails records nothing */
      })
      .finally(() => {
        checking = null;
        const next = takeHeld();
        if (next) refused(next);
      });
  };

  /** Ask about the next refusal held back, unless a check is under way, which does so when it ends. */
  const askHeld = (): void => {
    if (checking) return;
    const next = takeHeld();
    if (next) refused(next);
  };

  /** Read what Claude's records gained. `live`: Claude is running, so which conversation it is in can be asked. */
  const look = (live: boolean): void => {
    if (!watch) return;
    const pid = child?.pid;
    if (live && pid !== undefined) watch.noteConversation(pid);
    const news = watch.poll();
    const conversation = watch.conversation();
    for (const refusal of news.refusals) refused({ refusal, conversation });
  };

  return {
    started(claude) {
      child = claude;
      watch = createRecordWatch({ configDir: chosen.dir, startsNew, launchedAt: Date.now(), resumes });
      timer = setInterval(() => {
        try {
          look(true);
        } catch {
          /* unreadable this time: the next look reads it */
        }
      }, context.editorFollowMs ?? FOLLOW_MS);
      timer.unref?.();
    },
    ending() {
      ending = true;
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      askHeld();
    },
    async finished(result) {
      if (timer) clearInterval(timer);
      timer = null;
      ending = true;
      // A refusal written just before Claude exited. Its per-process record went
      // with it, so the conversation is the one last seen.
      try {
        look(false);
      } catch {
        /* nothing more to read */
      }
      askHeld();
      const deadline = Date.now() + CHECK_WAIT_MS;
      while (checking !== null && Date.now() < deadline) await within(checking, deadline - Date.now());
      if (result.classification.kind !== 'capped' || covered(undefined)) return;
      await act(result.stderr, result.classification.reason ?? 'usage cap');
    },
  };
}

/** Where SIGTERM comes from, and how the wrapper ends itself: the process's own unless a test says. */
export interface WrapperDeps {
  signals?: SignalSource;
  exit?: (code: number) => never;
}

/**
 * Run Claude with `watch` following it, and end as the extension asks. Node
 * dies on SIGTERM unless something listens for it, which would lose a check
 * under way and the limit it would record. So the first SIGTERM is passed on
 * to Claude while it runs, and what is under way gets ENDING_MS, inside the 5 s
 * the extension waits before SIGKILL; a second SIGTERM ends the wrapper at once.
 */
async function runFollowed(
  watch: EditorWatch,
  run: (started: (child: ChildProcess) => void) => Promise<WatchedResult>,
  deps: WrapperDeps,
): Promise<number> {
  const signals = deps.signals ?? process;
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  const endedCode = exitCodeForSignal('SIGTERM');
  let asked = false;
  const onTerm = (): void => {
    if (asked) exit(endedCode);
    asked = true;
    watch.ending();
    const giveUp = setTimeout(() => exit(endedCode), ENDING_MS);
    giveUp.unref?.();
  };
  signals.on('SIGTERM', onTerm);
  try {
    const result = await run(watch.started);
    await watch.finished(result);
    return asked ? endedCode : result.exitCode;
  } finally {
    signals.removeListener('SIGTERM', onTerm);
  }
}

/**
 * WRAPPER mode: run the EXACT command an editor hands us (e.g. `<claude> ...args`)
 * on the chosen account, with inherited stdio so the extension's protocol is
 * untouched. While it runs, and once it has ended, a confirmed limit is
 * recorded and the active account moved, so the next chat starts elsewhere.
 * This is what the editor's claudeProcessWrapper setting points at.
 */
export async function wrapperLaunch(context: CliContext, argv: string[], deps: WrapperDeps = {}): Promise<number> {
  const chosen = await pickAccount(context);
  if (!chosen || argv.length === 0) {
    // No usable account, or nothing to run: exec the command untouched.
    if (argv.length === 0) return 0;
    return (await spawnWatched(argv[0]!, argv.slice(1))).exitCode;
  }
  ensureEditorReady(chosen.dir, context.ctx);
  const watch = watchEditorLaunch(context, chosen, argv.slice(1));
  return runFollowed(
    watch,
    (started) => spawnWatched(argv[0]!, argv.slice(1), { CLAUDE_CONFIG_DIR: chosen.dir }, started),
    deps,
  );
}

/**
 * DIRECT mode: resolve the real claude and run it with the given claude args on
 * the chosen account. Used when ccx-claude is invoked directly (not via an
 * editor that passes the full command).
 */
export async function editorLaunch(context: CliContext, args: string[], deps: WrapperDeps = {}): Promise<number> {
  const claude = getClaude(context);
  const chosen = await pickAccount(context);
  if (!chosen) {
    return (await launchWatched(args, { name: '', dir: '' }, { claude })).exitCode;
  }
  ensureEditorReady(chosen.dir, context.ctx);
  const watch = watchEditorLaunch(context, chosen, args);
  return runFollowed(
    watch,
    (started) => launchWatched(args, { name: chosen.name, dir: chosen.dir }, { claude }, started),
    deps,
  );
}

/** Probe health and select the best eligible account (pinned preferred). */
async function selectHealthy(
  context: CliContext,
  accounts: Account[],
  capped: Set<string>,
  pinned: string | undefined,
): Promise<Account | undefined> {
  const claude = getClaude(context);
  const healths = await probeAll(accounts, { claude });
  const loggedIn = signedInAndNotRejected(healths, accounts, context.ctx);
  const sel = select({ accounts, loggedIn, capped, ...(pinned ? { pinned } : {}) });
  return sel.ok ? accounts.find((a) => a.name === sel.account.name) : undefined;
}
