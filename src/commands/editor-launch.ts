import { listAccounts } from '../accounts/registry.js';
import { getActive, setActive } from '../state/active.js';
import { probeAll } from '../health/prober.js';
import { select } from '../selector/selector.js';
import { launchWatched, spawnWatched, type WatchedResult } from '../launcher/launcher.js';
import { loadLedger, updateLedger, markCapped, cappedNames, accountCapEnd } from '../ledger/ledger.js';
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
import type { Refusal } from '../session/transcript.js';
import { conversationIdIn, forksConversation, wantsExistingConversation } from '../launcher/conversation.js';
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
/** A limit on the whole account, among the limits a launch has recorded; one model's goes by its name. */
const WHOLE_ACCOUNT = 'the whole account';

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

interface EditorWatch {
  /** Told the pid of the Claude just started; following begins. */
  started(pid: number): void;
  /** After Claude has exited: its record's last news, the check still under way, then its standard error. */
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
 * answer, judged by the same rules as a terminal session's. Each limit is
 * recorded, and moves the editor, once per launch: a person retrying a refused
 * turn, or limit text on standard error about a limit the record already
 * proved, records nothing again.
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
  /** The limits this launch has recorded: the whole account's, or one model's by name. */
  const recordedLimits = new Set<string>();
  const covered = (model: string | undefined): boolean =>
    recordedLimits.has(WHOLE_ACCOUNT) || (model !== undefined && recordedLimits.has(normalizeModel(model)));
  let watch: RecordWatch | null = null;
  let pid: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  /** The check under way for a refused turn, and the newest one read meanwhile, which is asked about next. */
  let checking: Promise<void> | null = null;
  let held: Refusal | null = null;

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
    // Asked again after the check: one that finished first may have recorded it.
    if (covered(decision.model)) return;
    recordedLimits.add(decision.model === undefined ? WHOLE_ACCOUNT : normalizeModel(decision.model));
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

  const refused = (refusal: Refusal): void => {
    // Claude refuses every turn the person tries until a limit resets, and each
    // check spends the usage endpoint's budget, which every session on the
    // machine shares: a limit already recorded is not asked about again.
    if (!watch || covered(limitNamed(refusal.limitType)?.model)) return;
    if (checking) {
      held = refusal;
      return;
    }
    // Judged as things are when it is asked about: a held refusal against a
    // prompt typed while it waited.
    checking = act(refusal.text, refusal.apiError ?? refusal.error, watch.recorded(refusal, pid))
      .catch(() => {
        /* a check that fails records nothing */
      })
      .finally(() => {
        checking = null;
        const next = held;
        held = null;
        if (next) refused(next);
      });
  };

  /** Read what Claude's records gained. `live`: Claude is running, so which conversation it is in can be asked. */
  const look = (live: boolean): void => {
    if (!watch) return;
    if (live && pid !== null) watch.noteConversation(pid);
    for (const refusal of watch.poll().refusals) refused(refusal);
  };

  return {
    started(childPid) {
      pid = childPid;
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
    async finished(result) {
      if (timer) clearInterval(timer);
      timer = null;
      // A refusal written just before Claude exited. Its per-process record went
      // with it, so the conversation is the one last seen.
      try {
        look(false);
      } catch {
        /* nothing more to read */
      }
      const deadline = Date.now() + CHECK_WAIT_MS;
      while (checking !== null && Date.now() < deadline) await within(checking, deadline - Date.now());
      if (result.classification.kind !== 'capped' || covered(undefined)) return;
      await act(result.stderr, result.classification.reason ?? 'usage cap');
    },
  };
}

/**
 * WRAPPER mode: run the EXACT command an editor hands us (e.g. `<claude> ...args`)
 * on the chosen account, with inherited stdio so the extension's protocol is
 * untouched. While it runs, and once it has ended, a confirmed limit is
 * recorded and the active account moved, so the next chat starts elsewhere.
 * This is what the editor's claudeProcessWrapper setting points at.
 */
export async function wrapperLaunch(context: CliContext, argv: string[]): Promise<number> {
  const chosen = await pickAccount(context);
  if (!chosen || argv.length === 0) {
    // No usable account, or nothing to run: exec the command untouched.
    if (argv.length === 0) return 0;
    return (await spawnWatched(argv[0]!, argv.slice(1))).exitCode;
  }
  ensureEditorReady(chosen.dir, context.ctx);
  const watch = watchEditorLaunch(context, chosen, argv.slice(1));
  const result = await spawnWatched(argv[0]!, argv.slice(1), { CLAUDE_CONFIG_DIR: chosen.dir }, watch.started);
  await watch.finished(result);
  return result.exitCode;
}

/**
 * DIRECT mode: resolve the real claude and run it with the given claude args on
 * the chosen account. Used when ccx-claude is invoked directly (not via an
 * editor that passes the full command).
 */
export async function editorLaunch(context: CliContext, args: string[]): Promise<number> {
  const claude = getClaude(context);
  const chosen = await pickAccount(context);
  if (!chosen) {
    return (await launchWatched(args, { name: '', dir: '' }, { claude })).exitCode;
  }
  ensureEditorReady(chosen.dir, context.ctx);
  const watch = watchEditorLaunch(context, chosen, args);
  const result = await launchWatched(args, { name: chosen.name, dir: chosen.dir }, { claude }, watch.started);
  await watch.finished(result);
  return result.exitCode;
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
