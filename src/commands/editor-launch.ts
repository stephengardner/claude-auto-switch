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
  editorStanding,
  moveEditorToActive,
  rememberEditorSpellings,
  setUpEditor,
  takeUpEditorRenewal,
  type EditorUp,
} from '../editor/folder.js';
import { editorFolderPath, folderSpellings, readEditorRecord } from '../editor/folder-login.js';
import { noteEditorChat } from '../editor/editor-chats.js';
import {
  confirmCap,
  refusalConfirmed,
  refusalLimitEnd,
  usageAnswer,
  type CapDecision,
} from '../usage/confirm-cap.js';
import {
  judgeRefusal,
  limitNamed,
  oldLoginWhy,
  type RecordedRefusal,
  type WriterLookup,
} from '../session/refused-turn.js';
import { createRecordWatch, type ReadRefusal, type RecordWatch } from '../session/record-watch.js';
import { createCheckBackoff } from '../session/check-backoff.js';
import type { Refusal } from '../session/transcript.js';
import { conversationIdIn, forksConversation, wantsExistingConversation } from '../launcher/conversation.js';
import { exitCodeForSignal, type SignalSource } from '../launcher/interruption.js';
import { normalizeModel } from '../usage/model-preference.js';
import { getClaude, type CliContext } from '../context.js';
import { newerToFollow } from '../update/follow.js';
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

/** The folder a launch runs Claude on. */
interface ClaudeFolder {
  /** Where ccx reads and writes it. */
  dir: string;
  /** The text Claude is given as its CLAUDE_CONFIG_DIR, which names the Keychain item it keeps its login in. */
  given: string;
  /** The editor's own folder, which ccx keeps on the active account, rather than the account's. */
  onEditor: boolean;
}

/**
 * Bring the editor's folder up on the active account and run Claude on it, as
 * the editor's extension is set to do: the user's own Claude but for the
 * login. A launch tries each step once and never waits on a lock. What it
 * could not do now (the move to the active account, a refresh) is left to a
 * later event, and the launch runs on the folder as it is, since it holds the
 * user's setup. Only a launch with no folder to run on, or one that is not
 * ready and whose folder holds no working login, runs on the account's own
 * folder, which holds only a login, and says why. Claude is given the folder
 * as an editor's setting spells it, when one lands on it, so every Claude
 * there keeps its login in one Keychain item and a renewal is never in a
 * second one that the next move overwrites. That spelling is noted in the
 * folder's record, so the item stays among those ccx reads and writes if the
 * setting is later edited away.
 */
async function claudeFolder(context: CliContext, chosen: Account): Promise<ClaudeFolder> {
  const home = configHome(context.ctx);
  const up = await setUpEditor(context, { launch: true });
  if (up.state !== 'ready') {
    const standing = editorStanding(context);
    if (!standing?.loggedIn) {
      const why = standing ? `${up.why}; the folder holds no working login` : up.why;
      appendEvent(
        home,
        `the editor's folder is not ready (${why}), so this chat runs on ${chosen.name}'s own folder`,
        Date.now(),
      );
      ensureEditorReady(chosen.dir, context.ctx);
      return { dir: chosen.dir, given: chosen.dir, onEditor: false };
    }
    if (up.state === 'not-ready') {
      appendEvent(
        home,
        `the editor's folder could not be brought up to date now (${up.why}); this chat runs on it as it is`,
        Date.now(),
      );
    }
  }
  const dir = editorFolderPath(context.ctx);
  const given = folderSpellings(dir, context.ctx)[0] ?? dir;
  // Kept in one try, since a launch does not wait on a lock; the next launch tries again.
  if (given !== dir) rememberEditorSpellings(context, [given], 0);
  return { dir, given, onEditor: true };
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
 * conversation from the per-process record Claude keeps in the folder it runs
 * on, followed when the process moves to another (a /clear), and that
 * conversation's record as it grows. Its standard error is still read once it
 * has ended, for what only that shows.
 *
 * However a limit was seen, one check decides it (`act`): the account's own
 * usage, with Claude's record of the refused turn standing in when that cannot
 * answer, judged by the same rules as a terminal session's. A limit the ledger
 * already holds for this account is neither asked about nor recorded again,
 * and a check that confirms nothing holds the next ones back as a terminal
 * session's does (session/check-backoff).
 *
 * On the editor's folder, every Claude there is on the account the folder
 * holds, and a confirmed limit moves the folder to the next account in place,
 * so the open chat's next message goes out on it. A refusal belongs to the
 * account the folder holds when it is judged, not the one picked at launch:
 * other ccx processes move the folder too, and one that comes just after a
 * move may be the login the folder left.
 */
function watchEditorLaunch(
  context: CliContext,
  chosen: Account,
  folder: ClaudeFolder,
  claudeArgs: string[],
): EditorWatch {
  const home = configHome(context.ctx);
  const startsNew = !wantsExistingConversation(claudeArgs);
  // An existing chat comes with `--resume=<id>`, and the extension starts its
  // Claude to send the turn the person just wrote, which can be refused before
  // the per-process record is first read.
  const resumes = startsNew || forksConversation(claudeArgs) ? null : conversationIdIn(claudeArgs);
  // The editor's folder links `sessions` to ~/.claude/sessions, which the lookup reads, so configDirs needs no change.
  const writers: WriterLookup = {
    sessionDir: null,
    configDirs: () => listAccounts(context.ctx).map((a) => a.dir),
    ctx: context.ctx,
    ...(context.isClaudeProcess ? { isClaude: context.isClaudeProcess } : {}),
  };
  /**
   * The account a refusal belongs to: the one the editor's folder holds as it
   * is judged, and else, when the folder is not the editor's or names none ccx
   * knows, the one picked at launch.
   */
  const holder = (): Account => {
    if (!folder.onEditor) return chosen;
    const name = readEditorRecord(folder.dir)?.account;
    return listAccounts(context.ctx).find((a) => a.name === name) ?? chosen;
  };
  /** When the login in the editor's folder was last replaced; 0 on any other folder. */
  const loginChangedAt = (): number =>
    folder.onEditor ? (readEditorRecord(folder.dir)?.loginChangedAt ?? 0) : 0;
  /**
   * Whether the ledger, which every session writes, holds a limit of this
   * scope for the account that still holds. An editor's Claude outlives a
   * limit's reset, and meeting it again after that is news.
   */
  const covered = (account: Account, model: string | undefined): boolean =>
    limitOnLedger(loadLedger(context.ctx), account.name, model, Date.now());
  const backoff = createCheckBackoff(context.refuteBackoffMs);
  /** Kept apart from the pause after a check that confirmed nothing: a move tried again says nothing of the next limit. */
  const moveBackoff = createCheckBackoff(context.refuteBackoffMs);
  let watch: RecordWatch | null = null;
  let child: ChildProcess | null = null;
  let timer: NodeJS.Timeout | null = null;
  /** Ends the note that this Claude runs on the editor's folder (editor-chats). */
  let forgetChat: (() => void) | null = null;
  /** The check under way for a refused turn, or the move of the editor tried again. */
  let checking: Promise<void> | null = null;
  /**
   * Refused turns waiting to be asked about, the newest of each limit. One
   * newest of all would let a refusal for one model, read later, push out the
   * whole account's, which is the only one that keeps the next chat off it.
   */
  const held = new Map<string, ReadRefusal>();
  /** Claude is ending or has ended: what is held is asked about now, whatever the back-off says. */
  let ending = false;

  const scopeOf = (refusal: Refusal): string => {
    const named = limitNamed(refusal.limitType);
    if (named === null) return UNNAMED;
    return named.model === undefined ? WHOLE_ACCOUNT : normalizeModel(named.model);
  };
  const hold = (refusal: ReadRefusal): void => {
    const scope = scopeOf(refusal);
    held.delete(scope);
    held.set(scope, refusal);
  };
  /** Every refusal held back, the whole account's first, since it takes in every other. */
  const takeHeld = (): ReadRefusal[] => {
    const all = [...held.entries()]
      .sort(([one], [other]) => Number(other === WHOLE_ACCOUNT) - Number(one === WHOLE_ACCOUNT))
      .map(([, refusal]) => refusal);
    held.clear();
    return all;
  };

  let leftToNewer = false;
  /**
   * Whether a newer ccx is installed (update/follow). This chat's Claude is
   * the editor's and cannot move to it, so from then on this older code saves
   * no login: moving the editor's folder, and taking a renewal its Claude made
   * home, are left to the newer ccx, from the next chat's start. Said once.
   */
  const leaveToNewer = (): boolean => {
    const newer = newerToFollow(context);
    if (!newer) return false;
    if (!leftToNewer) {
      leftToNewer = true;
      appendEvent(
        home,
        `ccx ${newer.version} is installed: this editor chat saves no logins from now on, and the next chat, on ccx ${newer.version}, moves the editor`,
        Date.now(),
        { kind: 'update', data: { to: newer.version } },
      );
    }
    return true;
  };

  // The injected verdict when a test supplies one, as the session path does; else the account's own login, never the editor folder's.
  const decide = async (
    account: Account,
    text: string,
    recorded?: RecordedRefusal,
  ): Promise<CapDecision> => {
    if (context.verifyCap) return { limited: (await context.verifyCap(text)) === 'limited' };
    // A renewal the editor's Claude made of this login comes home first, so the check does not run on a retired token.
    if (folder.onEditor && !leaveToNewer()) {
      await takeUpEditorRenewal(context.ctx, {
        account: account.name,
        ...(context.lookupOwner ? { lookupOwner: context.lookupOwner } : {}),
      });
    }
    return confirmCap(account.dir, text, {
      ...(context.capProbe ? { probe: context.capProbe } : {}),
      ...(recorded ? { refusal: judgeRefusal(recorded, writers, loginChangedAt) } : {}),
    });
  };

  /** Say how a move of the editor's folder to `to` went. */
  const reportMove = (to: string, up: EditorUp): void => {
    appendEvent(
      home,
      up.state === 'ready'
        ? `the editor moved to ${to}`
        : `the editor has not moved to ${to} yet: ${up.why}`,
      Date.now(),
    );
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
    const account = holder();
    const decision = await decide(account, text, recorded);
    const seenIn = recorded ? 'record' : 'stderr';
    const seen = recorded ? 'Claude recorded a refused turn in the editor' : 'limit text in the editor';
    if (!decision.limited) {
      backoff.pause(Date.now());
      appendEvent(
        home,
        decision.unanswered
          ? `${seen}, but not moving the editor yet: the usage check could not answer (${usageAnswer(decision)}), ` +
              `and ${decision.refusalWhy ?? 'Claude has not recorded the turn as refused'}`
          : `${seen}, but "${account.name}" shows no spent window; nothing recorded`,
        Date.now(),
        { kind: 'cap-verify', data: { account: account.name, seenIn } },
      );
      return;
    }
    // Asked again after the check: it may have been recorded meanwhile, here or elsewhere.
    if (covered(account, decision.model)) return;
    if (decision.byRefusal) {
      appendEvent(home, `in the editor, ${refusalConfirmed(decision)}`, Date.now(), {
        kind: 'cap-verify',
        data: { account: account.name, seenIn, confirmedBy: 'refusal' },
      });
    }
    const markedAt = Date.now();
    updateLedger(context.ctx, (ledger) =>
      markCapped(ledger, {
        account: account.name,
        now: markedAt,
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
            ? refusalLimitEnd(decision, () => accountCapEnd(ledger, account.name, markedAt))
            : decision.resetAt) ?? null,
        backoffMinutes: context.config.rotation.defaultBackoffMinutes,
        reason,
        // A model-scoped limit leaves the account working on everything else.
        ...(decision.model ? { model: decision.model } : {}),
      }),
    );
    appendEvent(home, `${account.name} hit its limit (editor)`, Date.now());
    // The account is spent whichever one the folder holds. If it moved on while the check ran, it is already elsewhere.
    const holdsNow = holder();
    if (holdsNow.name !== account.name) {
      appendEvent(home, `the editor had already moved to ${holdsNow.name}`, Date.now());
      return;
    }
    const next = await selectHealthy(
      context,
      listAccounts(context.ctx),
      cappedNames(loadLedger(context.ctx), Date.now()),
      undefined,
    );
    if (!next) return;
    setActive(next.name, context.ctx);
    if (!folder.onEditor) {
      appendEvent(home, `next editor chat will use ${next.name}`, Date.now());
    } else if (next.name === account.name) {
      // A model's limit leaves the account working on everything else, so it can be the next account.
      appendEvent(home, `the editor stays on ${next.name}`, Date.now());
    } else if (!leaveToNewer()) {
      reportMove(next.name, await moveEditorToActive(context));
    }
  };

  /**
   * A limit the ledger holds, met again by a Claude on the account the editor's
   * folder still holds, while another account is active: the move to it waited
   * on Claude's locks and did not come again at an event of ccx's, so it is
   * tried again, no more than once for each back-off. It holds refusals back
   * while it runs, as a check does. Nothing is asked of the usage endpoint.
   */
  const retryMove = (spent: Account): void => {
    if (!folder.onEditor || checking || moveBackoff.paused(Date.now())) return;
    if (readEditorRecord(folder.dir)?.account !== spent.name) return;
    const active = getActive(context.ctx);
    if (active === null || active === spent.name) return;
    // With every account spent there is nothing to move to.
    if (cappedNames(loadLedger(context.ctx), Date.now()).has(active)) return;
    if (leaveToNewer()) return;
    moveBackoff.pause(Date.now());
    checking = moveEditorToActive(context)
      .then((up) => reportMove(active, up))
      .catch(() => {
        /* the next refusal tries again */
      })
      .finally(() => {
        checking = null;
        askHeld();
      });
  };

  /**
   * Whether a refused turn may be the login the editor's folder left: it came
   * before the folder's last move, or soon enough after it that the Claude that
   * met it may still have been on the old login. It was the account the folder
   * left that refused it, so asking about the account it holds now would only
   * cost a check, and one that finds room.
   */
  const leftBehind = (recorded: RecordedRefusal): string | null => {
    const at = recorded.refusal.at;
    if (!folder.onEditor || at === null) return null;
    return oldLoginWhy(at, recorded.promptAt, loginChangedAt(), recorded.launchedAt);
  };

  const refused = (refusal: ReadRefusal): void => {
    if (!watch) return;
    // Claude refuses every turn the person tries until a limit resets, and each
    // check spends the usage endpoint's budget, which every session on the
    // machine shares: a limit the ledger holds is not asked about again.
    const account = holder();
    if (covered(account, limitNamed(refusal.limitType)?.model)) {
      retryMove(account);
      return;
    }
    const recorded = watch.recorded(refusal, child?.pid ?? null);
    const left = leftBehind(recorded);
    if (left !== null) {
      appendEvent(
        home,
        `Claude recorded a refused turn in the editor, but not asking about it: ${left}`,
        Date.now(),
      );
      return;
    }
    if (checking || (!ending && backoff.paused(Date.now()))) {
      hold(refusal);
      return;
    }
    checking = act(refusal.text, refusal.apiError ?? refusal.error, recorded)
      .catch(() => {
        /* a check that fails records nothing */
      })
      .finally(() => {
        checking = null;
        askHeld();
      });
  };

  /**
   * Ask about what is held back, each once: one the ledger now holds is let
   * go, and the first that starts a check holds the rest back again until it
   * ends, as the pause does while it lasts.
   */
  const askHeld = (): void => {
    for (const refusal of takeHeld()) refused(refusal);
  };

  /** Read what Claude's records gained. `live`: Claude is running, so which conversation it is in can be asked. */
  const look = (live: boolean): void => {
    if (!watch) return;
    const pid = child?.pid;
    if (live && pid !== undefined) watch.noteConversation(pid);
    for (const refusal of watch.poll().refusals) refused(refusal);
  };

  return {
    started(claude) {
      child = claude;
      if (folder.onEditor && claude.pid !== undefined) {
        const forget = noteEditorChat(context.ctx, claude.pid, folder.dir);
        // ccx-claude can end without `finished`: it gives up on a Claude that will not end, or is told to end twice.
        process.once('exit', forget);
        forgetChat = () => {
          process.removeListener('exit', forget);
          forget();
        };
      }
      watch = createRecordWatch({
        configDir: folder.dir,
        startsNew,
        launchedAt: Date.now(),
        resumes,
      });
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
      forgetChat?.();
      forgetChat = null;
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
      if (result.classification.kind !== 'capped' || covered(holder(), undefined)) return;
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
 * on the editor's own folder, with inherited stdio so the extension's protocol
 * is untouched. While it runs, and once it has ended, a confirmed limit is
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
  const folder = await claudeFolder(context, chosen);
  const watch = watchEditorLaunch(context, chosen, folder, argv.slice(1));
  return runFollowed(
    watch,
    (started) =>
      spawnWatched(argv[0]!, argv.slice(1), { CLAUDE_CONFIG_DIR: folder.given }, started),
    deps,
  );
}

/**
 * DIRECT mode: resolve the real claude and run it with the given claude args on
 * the editor's own folder. Used when ccx-claude is invoked directly (not via an
 * editor that passes the full command), as Conductor does with
 * `claude_code_executable_path`.
 */
export async function editorLaunch(context: CliContext, args: string[], deps: WrapperDeps = {}): Promise<number> {
  const claude = getClaude(context);
  const chosen = await pickAccount(context);
  if (!chosen) {
    return (await launchWatched(args, { name: '', dir: '' }, { claude })).exitCode;
  }
  const folder = await claudeFolder(context, chosen);
  const watch = watchEditorLaunch(context, chosen, folder, args);
  return runFollowed(
    watch,
    (started) => launchWatched(args, { name: chosen.name, dir: folder.given }, { claude }, started),
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
