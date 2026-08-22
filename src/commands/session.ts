import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { configHome, type PathCtx } from '../config/paths.js';
import { listAccounts } from '../accounts/registry.js';
import { getActive, setActive } from '../state/active.js';
import {
  readSwitchRequest,
  clearSwitchRequest,
  decideSwitch,
  writeSwitchRequest,
} from '../state/switch-request.js';
import { startProactiveRotation } from '../usage/proactive.js';
import { buildProactiveDeps } from '../usage/proactive-deps.js';
import { syncEditorPointerIfEnabled } from '../editor/junction.js';
import {
  loadLedger,
  saveLedger,
  markCapped,
  cappedNames,
  modelOnlyLimit,
  activeModelCaps,
} from '../ledger/ledger.js';
import { readToken } from '../daemon/token-store.js';
import { readReferenceConfig, onboardingFlags } from '../daemon/reference-config.js';
import { runHotSwapSession, type SessionOutcome } from '../launcher/hot-swap.js';
import { lastResortStart } from '../session/last-resort.js';
import { sessionDirFor, sweepDeadSessionDirs, seedFromKeptSettings } from '../session/session-dir.js';
import { runPtySession } from '../launcher/pty-session.js';
import { openTerminalInput } from '../launcher/terminal-input.js';
import {
  notifyAccountSwitch,
  notifyTerminal,
  setTerminalOwnedElsewhere,
} from '../launcher/notify.js';
import { ensureSharedProjects, mergeUserSettings } from '../session/shared-root.js';
import { confirmSessionCap } from '../usage/confirm-cap.js';
import { resolveSessionIdentity, maskEmail } from '../session/session-identity.js';
import { createTerminalWriter } from '../ui/terminal-writer.js';
import { readUsageSnapshot, refreshUsage, snapshotAgeMs } from '../usage/usage-store.js';
import { startUsageRefresher } from '../usage/usage-refresher.js';
import { planRotation, spentKey } from '../usage/rotation-plan.js';
import { createRefusalWatch } from '../usage/refusal-watch.js';
import { withModel, modelInArgs } from '../usage/model-args.js';
import { planConversation, relaunchArgs, freshStartArgs } from '../launcher/conversation.js';
import { readConversation, readRunningModel, rememberReport } from '../session/claude-report.js';
import { usableCapacity } from '../usage/usable-capacity.js';
import { secureMkdir, writeSecretFile, copySecretFile } from '../util/secret-file.js';
import {
  installCredential,
  rollbackCredential,
  isUsableCredential,
  identityKey,
  sessionIdentityEmail,
  credentialFingerprint,
} from '../accounts/credential-vault.js';
import { hasLogin, hasWorkingLogin } from '../accounts/account-login.js';
import {
  propagateRenewal,
  snapshotSharing,
  writeAndCarry,
  type SharingSnapshot,
} from '../accounts/shared-login.js';
import { carryTargets } from '../accounts/duplicate-guard.js';
import {
  pullProfileIntoSession,
  recoverLoginFromLiveSession,
} from '../accounts/credential-sync.js';
import { decideSaveBack } from '../accounts/save-back.js';
import {
  freshMirrorState,
  shouldCheck,
  beginCheck,
  finishCheck,
  abandonCheck,
  type SaveOutcome,
} from '../session/mirror-state.js';
import { fetchTokenOwner } from '../accounts/identity-check.js';
import { takeLease, touchLease, releaseLease } from '../session/lease.js';
import { activateWithLease, finishWithLease } from '../session/handoff.js';
import { ensureLoginUsable, readinessMessage, swapMode } from '../session/preflight.js';
import { renewalIsDue, refreshCredentialIfExpired } from '../usage/oauth-refresh.js';
import { withCredentialLock, withCredentialLockIfFree, acquireLockDir } from '../claude/locks.js';
import { logCredentialEvent } from '../accounts/credential-log.js';
import { appendEvent, type EventDetail } from '../events/log.js';
import { getClaude, type CliContext } from '../context.js';
import type { Account } from '../accounts/registry.schema.js';

const CREDS = '.credentials.json';

/** True when at least one account can run (hot-swap is possible). */
export function hasAnyUsableAccount(context: CliContext): boolean {
  // Deliberately the NARROW question. This decides whether to take the hot-swap
  // path at all, and that path is where a rejected login is skipped and named
  // with the command that fixes it. Asking the strict question here would send a
  // set of accounts whose logins are all finished DOWN THE OTHER PATH, which
  // probes each one slowly and never says what is actually wrong. Being signed
  // out is a reason to enter the swap loop, not to skip it.
  return listAccounts(context.ctx).some((a) => hasLogin(a.dir));
}

/** Seed the session dir with an account's settings (the model pin) so swaps stay on the model. */
function seedSessionSettings(sessionDir: string, accounts: Account[]): void {
  const dest = path.join(sessionDir, 'settings.json');
  if (existsSync(dest)) return;
  for (const account of accounts) {
    const src = path.join(account.dir, 'settings.json');
    if (existsSync(src)) {
      copySecretFile(src, dest);
      return;
    }
  }
}

/**
 * The model this session is running, or null when nothing pins one.
 *
 * Read from the settings file the session dir uses, which is where the model pin
 * lives, and from `--model` on the command line, which wins because it is the
 * more explicit of the two.
 */
function sessionModel(sessionDir: string, args: string[]): string | null {
  // Same parser the rewriting uses, so a spelling one accepts cannot be a
  // spelling the other misses.
  const fromArgs = modelInArgs(args);
  if (fromArgs) return fromArgs;
  const settings = readJsonSafe(path.join(sessionDir, 'settings.json'));
  const model = settings?.model;
  return typeof model === 'string' && model.length > 0 ? model : null;
}

function readJsonSafe(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The account-identity fields that must follow the active account across swaps. */
function identityFields(accountDir: string): Record<string, unknown> {
  const account = readJsonSafe(path.join(accountDir, '.claude.json')) ?? {};
  const id: Record<string, unknown> = {};
  for (const key of ['oauthAccount', 'userID']) {
    if (key in account) id[key] = account[key];
  }
  return id;
}

/**
 * Build/refresh the session's .claude.json so the interactive app treats it as
 * fully onboarded and logged in as the active account.
 * - First build: inherit the user's onboarding flags (from their default config)
 *   so login/theme/trust prompts are skipped, mark the cwd trusted, and stamp the
 *   account identity.
 * - Later swaps: only re-stamp the identity, PRESERVING everything the user has
 *   answered in this session dir (so prompts do not reappear).
 */
function applyAccountIdentity(sessionDir: string, accountDir: string, ctx: PathCtx): void {
  const sessionPath = path.join(sessionDir, '.claude.json');
  const existing = readJsonSafe(sessionPath);
  const identity = identityFields(accountDir);

  if (existing && existing.hasCompletedOnboarding) {
    writeJsonSafe(sessionPath, { ...existing, ...identity });
    return;
  }

  // First build: inherit the user's FULL working config (onboarding done, theme,
  // trusted folders, MCP servers, all preferences), then overlay this account's
  // identity and mark the current folder trusted. This reproduces their normal
  // environment exactly, minus the account, so no first-run prompts appear.
  const reference = readReferenceConfig(ctx);
  const base = Object.keys(reference).length > 0 ? { ...reference } : onboardingFlags({});
  // Guard identity bleed: if the target account has no identity of its own, do
  // not let the default account's identity (inherited via `base`) survive.
  if (!('oauthAccount' in identity)) delete base.oauthAccount;
  if (!('userID' in identity)) delete base.userID;
  const cwd = process.cwd();
  const projects: Record<string, unknown> =
    typeof base.projects === 'object' && base.projects
      ? { ...(base.projects as Record<string, unknown>) }
      : {};
  projects[cwd] = {
    ...(projects[cwd] as Record<string, unknown>),
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };

  writeJsonSafe(sessionPath, {
    ...base,
    hasCompletedOnboarding: true,
    ...identity,
    projects,
  });
}

/** Write the session config owner-only: it carries the account's identity. */
function writeJsonSafe(file: string, data: unknown): void {
  try {
    writeSecretFile(file, JSON.stringify(data));
  } catch {
    /* best effort */
  }
}

/**
 * Run an interactive session with transparent hot-swap. ONE session dir holds
 * the conversation (and the id to resume it by, so a swap comes back to THIS
 * conversation rather than the most recent one in the folder); each swap copies the
 * chosen account's credential file into that dir (and copies the live,
 * possibly-refreshed credential back out first, so nothing is lost). This uses
 * the logins you already have, with no tokens, on Windows and Linux.
 */
export async function runInteractiveHotSwap(context: CliContext, args: string[]): Promise<number> {
  const accounts = listAccounts(context.ctx);
  const claude = getClaude(context);
  // A directory of this session's OWN, never one shared with other sessions.
  // Starting a session copies the chosen account's login into here, so while
  // this was shared the second session to start took the first one's account:
  // the first terminal carried on as somebody else, its limits were recorded
  // against the wrong account, and the save-back wrote the borrowed login into
  // the wrong profile. Swept first, because a session that is killed never gets
  // to clean up, and what it leaves behind is a credential.
  sweepDeadSessionDirs(context.ctx, { keepPid: process.pid });
  const sessionDir = sessionDirFor(process.pid, context.ctx);
  secureMkdir(sessionDir);
  const sessionCreds = path.join(sessionDir, CREDS);
  // Share the user's REAL ~/.claude session/memory store (projects) so /resume
  // and project memories are complete and identical in ccx sessions and plain
  // `claude` alike. Self-heals each start; skips safely if files are busy.
  ensureSharedProjects(sessionDir, context.ctx);
  // The model pin lives in these settings, and this directory is new every
  // session now, so carry forward what the last one ended with before falling
  // back to an account's defaults.
  seedFromKeptSettings(sessionDir, context.ctx);
  seedSessionSettings(sessionDir, accounts);
  // Bring in the user's real settings (hooks, permissions), session keys winning.
  mergeUserSettings(sessionDir, context.ctx);
  // Drop any stale switch request so a fresh session starts on the active account
  // and only a NEW mid-session pick triggers an in-place swap.
  clearSwitchRequest(context.ctx);
  const err = context.err ?? ((m: string) => process.stderr.write(`${m}\n`));
  const home = configHome(context.ctx);
  // Record events to the shared log so an open `ccx dashboard` shows swaps live.
  // The detail is the evidence a decision was based on, so the log can answer
  // "why did it do that" on its own.
  const logEvent = (m: string, detail: EventDetail = {}): void =>
    appendEvent(home, m, Date.now(), detail);
  const debugLog = process.env.CAS_DEBUG ? path.join(sessionDir, 'session-debug.log') : undefined;

  // Name this run's conversation before anything starts, so a swap resumes THIS
  // thread rather than whichever one in this directory was touched last. Two
  // sessions open on the same project used to be able to take each other's.
  const conversation = planConversation(args);
  args = conversation.args;
  // Not a constant: a resume that finds nothing starts a new conversation, and
  // the run has to carry the new id from then on.
  let plannedConversationId = conversation.id;
  /** The conversation to resume, preferring what Claude itself reported. */
  const conversationId = (): string | null =>
    readConversation(sessionDir) ?? plannedConversationId;

  /**
   * True while Claude owns the screen. Anything ccx writes to stderr then lands
   * INSIDE Claude's interface, which is why those [ccx] lines appeared to insert
   * themselves into the UI at random: they were doing exactly that.
   */
  let claudeOwnsScreen = false;
  /**
   * The model rotation moved to, once the one in use ran out everywhere. Kept
   * for the rest of the run so later rotations start from the model actually in
   * use rather than the one that is already spent.
   */
  let chosenModel: string | null = null;
  /**
   * "account|model" pairs proven spent during THIS run.
   *
   * PER ACCOUNT, which is the whole point. Held as a bare list of models, one
   * account running out of Fable read as every account being out of Fable: the
   * run switched to Opus permanently and never went back, while another
   * account still had a quarter of its Fable week. It also bounds the loop,
   * since each confirmed limit removes exactly one pairing from the space.
   */
  const spentThisRun = new Set<string>();

  /**
   * Tell the operator something, by whichever channel does not wreck the screen.
   *
   * While a session runs that means the terminal's own notification and title,
   * which draw nothing, plus the event log that `ccx dashboard` and `ccx history`
   * read. Between sessions, when nothing owns the screen, plain stderr.
   */
  const notice = (message: string, detail: EventDetail = {}): void => {
    // While Claude owns the terminal this goes to the LOG and nowhere else.
    // Writing anything, even an escape sequence that renders nothing, pushes
    // bytes into a terminal that is mid-draw and corrupts what is on screen.
    // `ccx dashboard` and `ccx history` are where these are read.
    logEvent(message, detail);
    if (!claudeOwnsScreen) err(`[ccx] ${message}`);
  };

  /**
   * The one owner of what ccx writes to this terminal: closing messages are
   * held while Claude is drawing (last one wins) and said when the screen comes
   * back, the child's terminal modes are put back at the end of the run, and a
   * crash guard covers a wrapper that dies without its finally blocks.
   */
  const screen = createTerminalWriter({ line: err });

  /** Claude has the terminal from here; ccx stays off it until told otherwise. */
  const takeScreen = (owned: boolean): void => {
    claudeOwnsScreen = owned;
    setTerminalOwnedElsewhere(owned);
    // Handed back: anything held while Claude was drawing can be said now.
    if (owned) screen.childStarted();
    else screen.childEnded();
  };

  let current: Account | null = null;
  /**
   * The account name we announced as in use.
   *
   * Kept separately from `current` because that is only ever assigned inside
   * callbacks, so the compiler cannot see it change and narrows it away at the
   * end of the function.
   */
  let announced: string | null = null;

  // Which model was out, when the limit was about one model rather than the
  // whole account. Recorded with the limit so it never blocks other models.
  // Counts refusals ccx could not verify, so a limit it cannot explain can
  // never leave the session refusing forever. See usage/refusal-watch.
  const unverifiedLimits = createRefusalWatch();
  /** The probe's own words for the last refusal, so the log can repeat them. */
  let refusalReason: string | null = null;
  let limitedModel: string | undefined;
  /**
   * The confirmed limit's own reset time. The PTY outcome only carries what
   * the screen text offered, which is usually nothing; the probe's answer is
   * the one worth recording, or the ledger falls back to a fixed backoff and
   * benches the account long after its window reopened.
   */
  let limitedResetAt: number | undefined;
  /**
   * Who a confirmed limit actually belongs to, when that is not the account
   * ccx believed. A session forced through /login comes back as whatever
   * account the browser picked, and from then on the limit banner on screen is
   * THAT account's. Recording the cap against the believed account would take
   * a healthy account out of rotation on somebody else's limit.
   */
  let capOwner: string | null = null;
  /**
   * Set when the session turned out to be signed in as an address nobody has
   * registered. There is no account to cap, and no account SHOULD be capped:
   * the session still rotates off it, and the log says why nothing was
   * recorded.
   */
  let capUnregisteredEmail: string | null = null;

  /**
   * Tell the rotation how WIDE a limit was, so a spent model does not read as a
   * spent account.
   *
   * Without this the caller sees a bare "capped" and sets the account aside,
   * which empties the candidate list and skips the model switch that lives in
   * `nextAccount`, because that only runs while there are candidates left.
   */
  const withCapScope = (outcome: SessionOutcome): SessionOutcome =>
    outcome.kind === 'capped' && limitedModel ? { ...outcome, cappedModel: limitedModel } : outcome;

  /**
   * The model this session is ACTUALLY running.
   *
   * Claude reports it to the status line on every render, and that beats what
   * ccx asked for at launch: once the operator changes model with `/model`, the
   * two disagree and every check downstream is answering about the wrong model.
   * That is not theoretical. A session on Fable, believed to be on Opus, had
   * its real Fable limit dismissed as "a limit on a model you are not using",
   * over and over, and never rotated.
   */
  const runningModel = (): string | null =>
    readRunningModel(sessionDir) ?? chosenModel ?? sessionModel(sessionDir, args);

  // Ground-truth cap check: rendered text only TRIGGERS this; the API decides.
  //
  // Asked of the SESSION'S OWN login, because with one directory per session
  // that login is exactly the identity that rendered the banner on screen. The
  // profile is only the guess: after a mid-session /login the session can be a
  // different account than ccx believes, and asking the believed account about
  // the actual account's banner is how a session deadlocked for hours, probing
  // a healthy account and logging "no cap is confirmed" on every render.
  //
  // WHO the limit belongs to is resolved alongside, and the cap is recorded
  // against that account, never against the believed one on somebody else's
  // evidence.
  const verifyCap = async (renderedText: string): Promise<boolean> => {
    let verdict: string;
    let refusalData: EventDetail['data'];
    if (context.verifyCap) {
      verdict = await context.verifyCap(renderedText);
      // The injected verifier answers yes or no and nothing else, so anything
      // held from an EARLIER verification must not survive into this one: a
      // stale model here scopes the new cap to a limit it did not come from.
      limitedModel = undefined;
      limitedResetAt = undefined;
    } else {
      const identity = resolveSessionIdentity({
        sessionDir,
        believed: current,
        accounts,
      });
      const decision = await confirmSessionCap(
        { sessionDir, believedDir: current?.dir ?? null },
        renderedText,
        // Scoped to what this session is actually running: a spent window for
        // a model it is not on is not a limit on it.
        { modelInUse: runningModel() },
      );
      verdict = decision.limited ? 'limited' : 'allowed';
      limitedModel = decision.model;
      limitedResetAt = decision.resetAt;
      // Identities are logged by ACCOUNT NAME when they resolve to one, and as
      // a masked address when they do not: the event log is a rotating shared
      // file the dashboard renders, and a raw address is a stronger identifier
      // than it needs to carry.
      const identityLabel = identity.actual
        ? identity.actual.name
        : identity.email
          ? maskEmail(identity.email)
          : null;
      const running = runningModel();
      refusalData = {
        askedOf: decision.askedOf,
        ...(decision.detail ? { detail: decision.detail } : {}),
        ...(current ? { believed: current.name } : {}),
        ...(identityLabel ? { sessionIdentity: identityLabel } : {}),
        // The model as CLAIMED and as REPORTED, separately. When these two
        // disagree every downstream check is answering about the wrong model,
        // and the log has to make that visible rather than print one of them.
        ...(running ? { running } : {}),
        ...(chosenModel ? { ccxChose: chosenModel } : {}),
      };

      // The one refusal that can be wrong about a limit that is really
      // happening. Everything else refused here is a case where the API
      // positively reported room; this is the case where it could not account
      // for a limit at all. Left to itself it repeats forever, which is the
      // operator sitting blocked while the log fills with reasons not to act.
      // Only ever escalates with a model to scope it to. Without one the
      // outcome is an account-wide cap, which takes the whole account out of
      // rotation on evidence nobody could prove: strictly worse than the
      // refusal it was meant to correct. The model is known in practice (the
      // status line reports it within seconds), and an escalation needs
      // minutes of refusals to trigger, so this costs nothing real.
      refusalReason = decision.detail ?? null;
      if (!decision.limited && decision.unverified) {
        // Keyed by the MODEL and nothing else.
        //
        // The detail used to be in this key, and that inverted the whole
        // safeguard: the counter resets when the key changes, so every variation
        // in WORDING started the count again. A session refused for one reason,
        // then another, then the first again, never reached the threshold. The
        // net that exists to stop infinite refusal therefore got weaker the more
        // ways ccx failed to explain the limit, which is exactly backwards.
        //
        // Measured: six refusals over five minutes, alternating between "Fable
        // is spent but this session is running opus" and probe verdicts, with no
        // escalation, while a scheduled task retried every ten minutes and got
        // nowhere. What matters is that the session is BLOCKED and on which
        // model, never which sentence explained it best. A `/model` change is
        // still a genuinely different situation, so the model stays in the key.
        if (running && unverifiedLimits.refused(running, Date.now())) {
          verdict = 'limited';
          // Scoped to the model actually running, and with no reset time,
          // because none was ever proven. That keeps the run out of this
          // account/model pairing without writing a dated cap nobody measured.
          limitedModel = running;
          limitedResetAt = undefined;
          logEvent(
            'the limit keeps coming back and no window explains it, so rotating anyway ' +
              'rather than leaving the session stuck',
            { kind: 'cap-verify', data: { ...refusalData, escalated: true } },
          );
        }
      } else {
        // Any CONCLUSIVE answer clears the pattern: a limit ccx could account
        // for, and equally the API positively reporting room.
        //
        // Only the first of those used to reset. An unverified refusal, then a
        // clean "you have room", then two more refusals would escalate from the
        // timestamp before the all-clear, so a session was benched on a spread
        // the evidence never had. Widening the key to the model made that worse,
        // not better: timestamps now survive across more situations, so a stale
        // first one lingers where it used to be discarded with the wording.
        unverifiedLimits.reset();
      }
      if (decision.limited && identity.mismatch) {
        if (identity.actual) {
          capOwner = identity.actual.name;
          logEvent(
            `this session is actually "${identity.actual.name}", not "${current?.name}"; ` +
              `the limit on screen belongs to "${identity.actual.name}" and is recorded there`,
            {
              kind: 'identity-mismatch',
              data: {
                believed: current?.name ?? null,
                actual: identity.actual.name,
                askedOf: decision.askedOf,
                ...(decision.model ? { model: decision.model } : {}),
              },
            },
          );
        } else {
          capUnregisteredEmail = identity.email ? maskEmail(identity.email) : 'an unknown login';
          logEvent(
            `this session is signed in as ${capUnregisteredEmail}, which is not a registered ` +
              'account; rotating off it without recording a cap against anyone',
            {
              kind: 'identity-mismatch',
              data: { believed: current?.name ?? null, actual: null, email: capUnregisteredEmail },
            },
          );
        }
      }
    }
    if (verdict !== 'limited') {
      // This fires whenever limit-looking text renders and the API refutes it,
      // which includes a conversation that merely TALKS about rate limits. Far
      // too noisy for the screen; the log is where it belongs, and it carries
      // the probe's answer so the refusal can be judged later.
      // Carries the probe's OWN reason. The old wording claimed no window was
      // spent, which was frequently untrue: the common case is a window that IS
      // spent on a model ccx does not believe this session is running, and that
      // reads as "the account is fine" to anyone watching. It sent the operator,
      // and me, looking in the wrong place for an hour.
      notice(
        `limit text on screen, but not switching: ${refusalReason ?? 'the API reported room'}`,
        { kind: 'cap-verify', ...(refusalData ? { data: refusalData } : {}) },
      );
    }
    return verdict === 'limited';
  };

  /**
   * What happened to a save-back, from the caller's point of view.
   *
   * 'settled' means there is nothing more to do for THIS credential: it was
   * written, or it was refused, and a refusal cannot change until the file does.
   * 'retry' means the attempt failed for a reason that might not repeat, so the
   * next poll should try again rather than skip it.
   */
  const saveBack = (account: Account, confirmedOwner?: string | null): SaveOutcome => {
    // Nothing there to copy. A later tick may find one.
    if (!existsSync(sessionCreds)) return 'retry';
    // Never propagate a corrupt credential: a killed or partial OAuth refresh
    // can leave the session credential empty or malformed, and overwriting a
    // good login with that is the worst outcome (installCredential re-checks).
    if (!isUsableCredential(sessionCreds)) {
      // The session is signed out. Recording this is how "why was I asked to
      // sign in again?" becomes answerable later.
      logCredentialEvent(
        {
          account: account.name,
          kind: 'signed-out',
          detail: 'session had no login; left the stored one alone',
        },
        context.ctx,
      );
      // The session is signed out. Nothing to write, and nothing that a later
      // poll would write either, until the file changes.
      return 'settled';
    }
    // Identity guard. The session's config tracks whoever it is logged in as
    // right now, so if that is not this profile's account, writing the
    // credential back would put someone else's login into this profile. That is
    // how profiles end up scrambled or sharing one login, so it is refused.
    //
    // Checked against the address recorded when the account was registered,
    // which does not drift, rather than against the profile's own config file,
    // which can already be wrong by the time we look at it.
    // The decision itself lives in decideSaveBack, where it can be tested. It
    // was inline here, untested, and a gap in it went unnoticed for that reason.
    const decision = decideSaveBack({
      ...(confirmedOwner !== undefined ? { confirmedOwner } : {}),
      sessionEmail: sessionIdentityEmail(sessionDir),
      ...(account.email ? { accountEmail: account.email } : {}),
      sessionIdentity: identityKey(sessionDir),
      accountIdentity: identityKey(account.dir),
      accountName: account.name,
    });
    if (!decision.save) {
      // Log ONLY, never the screen, whoever owns it. This is ccx explaining an
      // internal decision the operator cannot act on mid-session, it can fire on
      // every credential change, and it was landing in Claude's interface. If it
      // matters, `ccx doctor` reports the same mismatch properly.
      logEvent(decision.reason);
      // A refusal is a settled answer about this credential: asking again can
      // only produce the same refusal, and re-asking is what froze the machine.
      return 'settled';
    }
    // The save and the carry are ONE call, so the snapshot cannot drift below
    // the write. This path matters more than the session-start one: it fires
    // every time a RUNNING Claude refreshes its own token, which is every few
    // hours, where the other only fires at launch. Carrying it across here is
    // what stops a duplicate profile rotting while its twin is in use.
    let carried: string[];
    try {
      carried = writeAndCarry(
        account,
        accounts,
        carryTargets(account, accounts),
        // Keeps the account's previous credential as a rollback cushion.
        () => void installCredential(account.dir, sessionCreds),
      );
    } catch {
      // A local write failure, not a decision. It might not repeat, and giving
      // up here would leave a refreshed token unsaved until the process exits.
      return 'retry';
    }
    announceCarried(account, carried);
    return 'settled';
  };

  /**
   * Give the profiles that shared this login the one that replaced it.
   *
   * Separate from the write so a failure to carry it across can never turn a
   * successful save into a retry: the account itself is already up to date, and
   * repeating the save would not help the siblings either.
   */
  const carryToSharedProfiles = (account: Account, sharing: SharingSnapshot): void => {
    announceCarried(
      account,
      propagateRenewal({
        renewedDir: account.dir,
        siblings: sharing.sharedWith,
        retired: sharing.fingerprint,
        renewed: credentialFingerprint(account.dir),
      }),
    );
  };

  /** Say which profiles were brought along, in the log for the right account. */
  const announceCarried = (account: Account, carried: string[]): void => {
    for (const name of carried) {
      logCredentialEvent(
        {
          account: name,
          kind: 'installed',
          detail: `shares a login with "${account.name}", which was just renewed; carried across so this one keeps working`,
        },
        context.ctx,
      );
    }
  };

  /**
   * Identifies the login stored in the session folder, by its CONTENT.
   *
   * Was modification time and size, which is not identity: a replacement of the
   * same size written within the filesystem's timestamp resolution looks
   * identical, and the mirror would then skip the ownership check and treat a
   * different login as one it had already settled. A hash of the token cannot
   * collide that way, and never exposes the token itself.
   */
  const credStamp = (): string => credentialFingerprint(sessionDir) ?? '';
  /**
   * Which credential has already been dealt with, and which is being looked up.
   * The rules live in mirror-state.ts, where they are tested on their own: this
   * bookkeeping has been got wrong in both directions and each mistake was
   * expensive.
   */
  let mirror = freshMirrorState();

  /**
   * Copy a login Claude just refreshed back to the account's own folder.
   *
   * Needed because a refresh REPLACES the login: once Claude renews the copy in
   * the session folder, the copy still sitting in the profile is dead. Saving back
   * only when the session ends leaves that dead login in place for as long as the
   * session runs, so the next terminal starts on it and is told to sign in again.
   *
   * Runs on the ordinary poll tick, and does nothing unless the file actually
   * changed. saveBack does the checking: a signed-out or someone-else's login is
   * never written over a good one.
   */
  const mirrorSessionLoginToProfile = (account: Account): void => {
    // Cheap pre-check before taking the lock; the same rule is applied again
    // inside it, because the file can change in between.
    if (!shouldCheck(mirror, credStamp())) return;
    // Under the same lock that serializes credential refreshes, so this copy
    // cannot run against a refresh that is part-way through writing.
    //
    // Try-only, never waiting: the lock's wait is a synchronous sleep loop of up
    // to two seconds, and this runs on the poll that also relays the session's
    // output, so waiting here would visibly freeze the terminal. A busy lock just
    // means someone else is writing, which is precisely when skipping is right;
    // the next tick picks it up, and the final save catches anything left.
    withCredentialLockIfFree(sessionDir, () => {
      // Re-read inside the lock: the file may have changed again between the
      // check above and getting the lock, and the stamp has to describe what was
      // actually copied or a later change would be treated as already mirrored.
      const nowStamp = credStamp();
      if (!shouldCheck(mirror, nowStamp)) return;
      // Claimed as IN FLIGHT rather than done, so the same credential is not
      // looked up twice while one answer is still coming back.
      mirror = beginCheck(mirror, nowStamp);

      // Ask who this login actually belongs to before copying it anywhere. The
      // local identity file lags a mid-session /login, so it still names the OLD
      // account at this moment and would wave the new account's login straight
      // into the wrong profile. Only the API can answer without lagging.
      //
      // Affordable because it runs on a CHANGED credential, not on every tick: a
      // refresh every few hours, or a sign-in. Not awaited, because the poll that
      // called this also relays the screen.
      void fetchTokenOwner(sessionDir)
        .then((owner) => {
          // The answer belongs to the credential that was READ, and the file can
          // change while the API is being asked. So the lock is taken AGAIN here
          // and the check is repeated inside it: checking outside the lock leaves
          // a window between "still the same" and the copy, and a login that
          // arrived in that window would be written under someone else's
          // confirmed identity.
          //
          // Try-only, as everywhere on this poll: a busy lock means someone else
          // is writing, and the next tick picks it up because the credential is
          // left unsettled.
          const ran = withCredentialLockIfFree(sessionDir, () => {
            if (credStamp() !== nowStamp) {
              // Superseded. Not settled: whatever replaced it still needs a look.
              mirror = abandonCheck(mirror, nowStamp);
              return;
            }
            mirror = finishCheck(mirror, nowStamp, saveBack(account, owner));
          });
          if (!ran) mirror = abandonCheck(mirror, nowStamp);
        })
        .catch(() => {
          // Could not reach the API, so nothing was decided and the credential
          // stays eligible for another try. A network blip must not mean a
          // refreshed token is never written back for the rest of the session.
          mirror = abandonCheck(mirror, nowStamp);
        });
    });
  };

  /**
   * Carry a renewal that happened ELSEWHERE into this running session.
   *
   * The mirror above is the other direction (this session renews, the profile
   * receives). Without this one, a renewal by any OTHER holder of the login (a
   * sibling session, a session start, the dashboard) retires the lineage this
   * session is holding, and its next refresh dies with "please run /login" in
   * the middle of working. Throttled: the common case is "same login on both
   * sides" and it needs checking, not checking every 400ms.
   */
  let lastPullCheck = 0;
  const pullRenewedLogin = (account: Account): void => {
    const now = Date.now();
    if (now - lastPullCheck < 5_000) return;
    lastPullCheck = now;
    if (pullProfileIntoSession(account, sessionDir, context.ctx) === 'pulled') {
      // What was just installed came FROM the profile, so it is not a change
      // to mirror back; settling it here saves an identity lookup per pull.
      mirror = finishCheck(beginCheck(mirror, credStamp()), credStamp(), 'settled');
      logEvent(`the "${account.name}" login was renewed elsewhere; this session picked it up`, {
        kind: 'credential-sync',
        data: { account: account.name, direction: 'pull' },
      });
    }
  };

  /** Remove the live credential from the shared session dir so it never lingers. */
  const scrubSessionCreds = (): void => {
    try {
      rmSync(sessionCreds, { force: true });
    } catch {
      /* best effort */
    }
  };

  /**
   * Point the shared session at `account`, transactionally. The whole swap runs
   * under Claude's own credential lock so it cannot collide with a background
   * token refresh, and a failure part-way rolls the session credential back
   * instead of leaving the session on a half-applied account.
   */
  const activate = (account: Account): void => {
    // A fresh activation installs this account's own login, so whatever
    // identity drift the previous session had is corrected here and the cap
    // attribution starts clean.
    capOwner = null;
    capUnregisteredEmail = null;
    // The ORDER of announce / copy / release is the safety property, so it lives
    // in activateWithLease where tests pin it: announce first, copy second,
    // release the old one last. Any gap between a login being in use and being
    // announced is a gap where a renewer can retire it.
    announced = activateWithLease(account.name, announced, {
      takeLease: (name) => takeLease(name, sessionDir, context.ctx),
      releaseLease: (name) => releaseLease(name, context.ctx),
      install: () => {
        withCredentialLock(sessionDir, () => {
          if (current && current.name !== account.name) saveBack(current);
          const src = path.join(account.dir, CREDS);
          // Always replace (or clear) the session credential so one account's login
          // can never linger into another account's session.
          try {
            // A refused credential (missing, or signed out with empty tokens) must
            // CLEAR the session, never leave the previous account's login in place:
            // the session would keep running as that account while ccx believed it
            // had moved, and its limit would then be blamed on the wrong account.
            if (!existsSync(src) || !installCredential(sessionDir, src)) {
              scrubSessionCreds();
            }
            // Stamp the account's identity (oauthAccount/userID) so the interactive
            // app sees a logged-in account instead of prompting for login.
            applyAccountIdentity(sessionDir, account.dir, context.ctx);
            // What we just put there is by definition already in the profile, so it
            // is not a change to mirror back.
            mirror = finishCheck(beginCheck(mirror, credStamp()), credStamp(), 'settled');
          } catch (e) {
            rollbackCredential(sessionDir);
            throw e;
          }
        });
      },
    });
    current = account;
  };

  /**
   * Write a confirmed cap to the ledger, honestly attributed.
   *
   * One function for BOTH callers: the swap loop's markCapped, and the
   * in-session model fallback. The fallback used to skip this entirely: when
   * switching model in place succeeded, the capped outcome never reached the
   * swap loop, the spent model went unrecorded, and every other session kept
   * choosing it.
   */
  const recordCap = (accountName: string, reason: string, resetAt: number | undefined): void => {
    if (capUnregisteredEmail) {
      // There is no registered account to record this against, and the
      // believed account must NOT take it: nothing of its is spent. The
      // rotation still moves off the session; this only skips the ledger.
      logEvent(
        `"${accountName}" was not capped: the limit belonged to ${capUnregisteredEmail}, ` +
          'which is not a registered account',
        { kind: 'cap-skipped', data: { email: capUnregisteredEmail, believed: accountName } },
      );
      capUnregisteredEmail = null;
      return;
    }
    saveLedger(
      markCapped(loadLedger(context.ctx), {
        account: accountName,
        now: Date.now(),
        resetAt: resetAt ?? limitedResetAt ?? null,
        backoffMinutes: context.config.rotation.defaultBackoffMinutes,
        reason,
        ...(limitedModel ? { model: limitedModel } : {}),
      }),
      context.ctx,
    );
    logEvent(`${accountName} hit its limit`, {
      kind: 'capped',
      data: {
        reason,
        resetAt: resetAt ?? limitedResetAt ?? null,
        ...(limitedModel ? { model: limitedModel } : {}),
      },
    });
  };

  // Claim the operator's keyboard once for the whole run; every session in the
  // swap loop borrows it, so terminal mode is never toggled mid-swap.
  const terminalInput = openTerminalInput(process.stdin, {
    onUnrequestedReports: ({ dropped, toldTerminalToStop }) => {
      logEvent(
        'this terminal is reporting mouse activity nothing asked for; dropping those ' +
          `reports so they cannot appear as typed text${
            toldTerminalToStop ? ', and telling it to stop' : ''
          }`,
        { kind: 'mouse-reports-dropped', data: { dropped, toldTerminalToStop } },
      );
    },
  });

  // Keep the usage snapshot alive for the whole run, whatever the proactive
  // setting is. Refreshing was coupled to proactive rotation (a feature, off
  // by default), so with no dashboard open NOTHING refreshed: rotation chose
  // targets from hours-old numbers and idle profiles' logins quietly rotted.
  const usageWatch = startUsageRefresher(
    {
      refresh: () => refreshUsage(listAccounts(context.ctx), context.ctx),
      snapshotAgeMs: () => snapshotAgeMs(context.ctx),
      tryLock: () => acquireLockDir(path.join(home, 'usage-refresh.lock'), { waitMs: 0 }),
      onOutcome: (outcome, detail) => {
        if (outcome === 'error') {
          const minutes = Number.isFinite(detail.ageMs) ? Math.round(detail.ageMs / 60_000) : null;
          logEvent(
            'usage refresh failed; rotation is choosing from ' +
              (minutes === null ? 'no data at all' : `data ${minutes} minutes old`),
            { kind: 'usage-refresh', data: { outcome, ...detail } },
          );
        }
      },
    },
    Math.max(30, context.config.rotation.usageCheckSeconds) * 1000,
  );

  // Watch our own headroom and hand the session to a roomier account before the
  // current one runs out. The switch goes through the normal request path, so
  // the conversation moves in place rather than restarting.
  const proactive = startProactiveRotation(
    buildProactiveDeps(context, {
      current: () => current?.name ?? null,
      requestSwitch: (account, reason) => {
        notice(`${reason}; moving to "${account}" before this account runs out`);
        setActive(account, context.ctx);
        syncEditorPointerIfEnabled(context);
        writeSwitchRequest(account, Date.now(), 'seamless', context.ctx);
      },
    }),
    Math.max(30, context.config.rotation.usageCheckSeconds) * 1000,
  );

  const exitCode = await runHotSwapSession({
    // Skipped up front rather than launched and rejected. These go into the same
    // set a runtime rejection goes into, so the closing message still says to
    // sign in instead of telling the operator to wait for a reset.
    knownDeadAccounts: () =>
      accounts.filter((a) => hasLogin(a.dir) && !hasWorkingLogin(a.dir, context.ctx)).map((a) => a.name),
    // Never selectable, so this is only for the ending: an account nobody has
    // signed into is otherwise silently absent, and the operator gets told to
    // wait for a reset that cannot produce a login.
    accountsNeverSignedIn: () =>
      accounts.filter((a) => a.enabled && !hasLogin(a.dir)).map((a) => a.name),
    nextAccount: (excluding) => {
      const capped = cappedNames(loadLedger(context.ctx), Date.now());
      const pinned = getActive(context.ctx);
      const eligible = accounts
        .filter(
          (a) => a.enabled && !excluding.has(a.name) && !capped.has(a.name) && hasLogin(a.dir),
        )
        .sort((a, b) => a.priority - b.priority);
      // Start on the pinned account if it is still eligible, else lowest priority.
      const ordered = pinned
        ? [...eligible.filter((a) => a.name === pinned), ...eligible.filter((a) => a.name !== pinned)]
        : eligible;

      // ONE decision, made by the planner: which account, on which model. The
      // model half used to be decided separately, inside the session, and it
      // fired first: one account running out of Fable moved the whole run to
      // Opus even though another account had most of its Fable week left, and
      // it was never reconsidered afterwards. See usage/rotation-plan.ts.
      const rotation = context.config.rotation;
      if (!rotation.preferSameModel || ordered.length === 0) {
        const pick = ordered[0];
        return pick ? { name: pick.name, dir: pick.dir } : null;
      }

      const snapshot = readUsageSnapshot(context.ctx);
      const now = Date.now();
      // Limits confirmed earlier, by this run or another one. Stronger than a
      // cached number, because a cap was proven against the account's own
      // usage at the moment it was written, so it wins where they disagree.
      const knownSpent = activeModelCaps(loadLedger(context.ctx), now);
      const plan = planRotation({
        candidates: ordered.map((a) => {
          // Read as CURRENT capacity, not as history: a cached number past its
          // own reset says "spent" about a limit that has already lifted, and
          // acting on it moves the session off a model it could still use. An
          // account-wide window that is genuinely closed makes every model
          // unusable, so it belongs in the candidate too.
          const capacity = usableCapacity(snapshot.accounts[a.name], now);
          const spentByLedger = Object.fromEntries(
            knownSpent.filter((c) => c.account === a.name).map((c) => [c.model, 1]),
          );
          return {
            name: a.name,
            models: { ...capacity.models, ...spentByLedger },
            ...(capacity.accountWideOut ? { accountWideOut: true } : {}),
          };
        }),
        // The model in use, or the one a confirmed cap just told us was in
        // use. Without that second source the first rotation is blind: nothing
        // pins a model, so ccx could not tell it was on Fable and rotated by
        // priority alone, straight through two accounts whose Fable was also
        // spent before reaching the one with room.
        modelInUse: runningModel() ?? limitedModel ?? null,
        preference: rotation.modelPreference,
        strategy: rotation.modelStrategy,
        spentThisRun,
      });

      if (plan.kind === 'exhausted') return null;
      const picked = ordered.find((a) => a.name === plan.account);
      if (!picked) return null;
      // ONLY on a change. Remembering it is what makes the session actually
      // start on it, but writing it down when nothing moved would impose
      // `--model` on a session that never asked for one, overriding the
      // operator's own pin with a value ccx picked.
      if (plan.changedModel && plan.model) {
        notice(plan.reason, { kind: 'model-change', data: { to: plan.model } });
        chosenModel = plan.model;
      }
      return { name: picked.name, dir: picked.dir };
    },
    resolveAccount: (name) => {
      const a = accounts.find((x) => x.name === name);
      return a && hasLogin(a.dir) ? { name: a.name, dir: a.dir } : null;
    },
    // The account the session is ACTUALLY on right now: a seamless swap may
    // have moved it, and a verified limit may have turned out to belong to the
    // account the session was really signed in as. Caps are attributed here.
    currentAccount: () => capOwner ?? current?.name ?? '',
    // Every account has hit a limit. If those limits are about ONE MODEL, the
    // session still works on another model, so start it and say which model is
    // out. Refusing here is what made a Fable limit look like being signed out.
    // Never a refusal to launch: see src/session/last-resort.ts. ccx is not the
    // authority on whether the server will serve a request, and being wrong
    // here costs the operator the whole session.
    lastResort: (excluding) =>
      lastResortStart({
        usable: accounts
          .filter((a) => a.enabled && !excluding.has(a.name) && hasWorkingLogin(a.dir, context.ctx))
          .map((a) => ({ name: a.name, dir: a.dir })),
        active: getActive(context.ctx),
        modelOnly: modelOnlyLimit(loadLedger(context.ctx), Date.now()),
      }),
    runSession: async (hotAccount, isContinue, runOptions) => {
      const account = accounts.find((a) => a.name === hotAccount.name);
      if (!account) return { kind: 'ok', exitCode: 1 };
      // A new child on a new account. Whatever refusals were adding up belonged
      // to the last one, and carrying them over would escalate here on evidence
      // gathered somewhere else.
      unverifiedLimits.reset();
      // Read BEFORE the renewal: it rotates the token, so afterwards there is
      // no shared value left to identify who was sharing it.
      const sharing = snapshotSharing(account, accounts, carryTargets(account, accounts));
      // Check the login BEFORE copying it into the session. A login that merely
      // expired is renewed here, which is safe precisely because nothing is using
      // this account yet, and a login that is genuinely finished is named, with
      // the command that fixes it, rather than turning into Claude saying you are
      // logged out for no visible reason.
      const checkReadiness = () =>
        ensureLoginUsable({
          hasLogin: () => hasLogin(account.dir),
          renewalDue: () => renewalIsDue(account.dir),
          renew: () => refreshCredentialIfExpired(account.dir, { ctx: context.ctx }),
        });
      let readiness = await checkReadiness();
      if (readiness.state === 'needs-login') {
        // The stored login is dead, but a LIVE session of this account may be
        // running on a renewed one the hub never heard about: its Claude
        // refreshed, the mirror had not landed yet, and the profile kept the
        // retired copy. Adopting the live one is the difference between
        // starting normally and demanding a sign-in the operator does not owe.
        const recovered = recoverLoginFromLiveSession(account, sessionDir, context.ctx);
        if (recovered.recovered) {
          logEvent(
            `the stored "${account.name}" login was dead; adopted the working one from ` +
              `its live session (pid ${recovered.fromPid})`,
            {
              kind: 'credential-sync',
              data: { account: account.name, direction: 'recover', fromPid: recovered.fromPid },
            },
          );
          readiness = await checkReadiness();
        }
      }
      if (readiness.state === 'renewed') {
        logCredentialEvent(
          {
            account: account.name,
            kind: 'renewed',
            detail: 'expired login renewed before starting',
          },
          context.ctx,
        );
        // Renewing retires the token it replaced, so any profile still holding
        // that token is finished from this moment. Those profiles are the SAME
        // account, so they are brought along rather than left to die: this is
        // how an account here actually died, renewed at a session start while a
        // duplicate profile kept the retired copy.
        //
        // The siblings were read BEFORE the renewal, because afterwards the
        // shared token is gone and there is nothing left to match on.
        carryToSharedProfiles(account, sharing);
      } else if (readiness.state === 'needs-login') {
        logCredentialEvent(
          { account: account.name, kind: 'needs-login', detail: readiness.detail },
          context.ctx,
        );
      }
      // A finished login means this account cannot work at all. Starting here
      // would hand Claude a dead token, which shows up as "Login expired" with
      // nothing to act on, so the account is reported as needing a sign-in and
      // the swap loop moves to the next one. Rotating past a broken account is
      // the whole point of the tool; blocking on it is not.
      if (readiness.state === 'needs-login') {
        return { kind: 'needs-login', exitCode: 1, reason: readiness.detail };
      }
      // Printed plainly: this happens BEFORE the session starts, so nothing owns
      // the screen yet and it is the one moment a sign-in problem is worth
      // interrupting for.
      const readinessNote = readinessMessage(account.name, readiness);
      if (readinessNote) err(readinessNote);
      activate(account);
      // Track the account we are actually on so the editor pointer follows it.
      setActive(account.name, context.ctx);
      syncEditorPointerIfEnabled(context);
      const token = readToken(account.dir);
      const env: Record<string, string> = token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
      // Watch for an operator-requested switch to a DIFFERENT, usable account.
      // Seamless (default) swaps credentials under the running process; 'restart'
      // returns the name so the child is ended and the loop resumes this conversation.
      /**
       * Two jobs that must keep running for as long as the session is alive,
       * both about not losing a login: say we are still using this account (so
       * the no-renew protection stays in force), and copy a token Claude just
       * refreshed back to the profile. Without the copy, the profile keeps the
       * token Claude's refresh already retired, and the NEXT `claude` starts on
       * a dead login and asks you to sign in.
       *
       * Deliberately separate from switchWatch: these ran inside it, and the
       * poll skips switchWatch once a cap or a switch is pending, so the session
       * went quiet exactly when it was still finishing up.
       */
      const onTick = (): void => {
        if (!current) return;
        touchLease(current.name, context.ctx);
        mirrorSessionLoginToProfile(current);
        pullRenewedLogin(current);
      };
      const switchWatch = (): string | null => {
        const request = readSwitchRequest(context.ctx);
        const onNow = current?.name ?? account.name;
        const decision = decideSwitch(request, onNow, (name) => {
          const t = accounts.find((a) => a.name === name);
          return !!t && hasLogin(t.dir);
        });
        if (decision.consume) clearSwitchRequest(context.ctx);
        if (!decision.switchTo) return null;
        const target = accounts.find((a) => a.name === decision.switchTo);
        if (!target) return null;
        if (request?.mode === 'restart') return target.name; // end child, resume this conversation
        // Seamless only when the target's login is usable right now. This swap is
        // synchronous, so there is no chance to renew anything first, and swapping
        // in an expired login lands the running session on a dead token. When it
        // needs work, relaunch instead: resuming by id keeps the same conversation and
        // the start path renews before handing it over.
        if (
          swapMode({
            hasLogin: () => hasLogin(target.dir),
            renewalDue: () => renewalIsDue(target.dir),
          }) === 'restart'
        ) {
          notice(`"${target.name}" needs its login refreshed first; continuing it there`);
          return target.name;
        }
        activate(target);
        setActive(target.name, context.ctx);
        // The account under this session just changed without the child
        // restarting, so refusals counted against the old one say nothing
        // about the new one.
        unverifiedLimits.reset();
        syncEditorPointerIfEnabled(context);
        notice(`switching to "${target.name}" (no restart; takes effect within ~30s)`);
        notifyAccountSwitch(target.name, 'switched in place');
        return null;
      };
      const base = {
        claude,
        configDir: sessionDir,
        env,
        switchWatch,
        onTick,
        verifyCap,
        input: terminalInput,
        ...(runOptions?.ignoreLimits ? { ignoreLimits: true } : {}),
        ...(debugLog ? { debugLog } : {}),
      };
      // A relaunch after a swap resumes this run's own conversation by id.
      // `--continue` was "the most recent one in this directory", which is a
      // different conversation entirely whenever two sessions share a project.
      const launchArgs = isContinue ? relaunchArgs(args, conversationId()) : args;

      // Not printed: which account you are on shows in Claude's status line
      // (`ccx statusline`) and in the terminal title, and a line per session
      // start was the most frequent of the [ccx] messages cluttering the screen.
      logEvent(`session on ${account.name}`);
      // Claude owns the screen from here, so tell the operator through the
      // terminal itself (a notification / title change draws nothing).
      notifyAccountSwitch(account.name, isContinue ? 'continued here' : 'session start');
      // From here until it returns, the screen belongs to Claude, so anything
      // ccx has to say goes through `notice` rather than onto the screen.
      takeScreen(true);
      try {
        // The chosen model is applied here, and stays applied for later
        // rotations in this run: once Fable is gone it does not come back
        // within a session, so re-checking it every time would only churn.
        const modelArgs = chosenModel ? withModel(launchArgs, chosenModel) : launchArgs;
        const outcome = await runPtySession({ ...base, args: modelArgs });
        // If we tried to resume but the new account has no saved conversation,
        // start a fresh session on it instead of dead-ending.
        if (outcome.kind === 'no-conversation') {
          notice('no conversation to resume on this account; starting fresh');
          // modelArgs, not args: this account was chosen for its room on the
          // CHOSEN model, so a fresh start on the old one would walk straight
          // back into the limit we just rotated away from. And drop the resume
          // flag the operator may have typed, or "fresh" would just repeat the
          // resume that found nothing.
          // The new conversation is NAMED, not just started. The id this run was
          // carrying has just been shown to lead nowhere, so leaving it in place
          // would have every later swap resume that same dead id, fail, and
          // start over, losing the conversation on every single swap.
          const fresh = freshStartArgs(modelArgs);
          plannedConversationId = fresh.id;
          // Overwrite the RECORDED id as well, not just the planned one. The
          // recording is read first (it is normally the more accurate of the
          // two), and it still holds the id that just failed to resume, so a
          // swap arriving before the new session's first status line would
          // resume that dead id all over again.
          rememberReport(sessionDir, { id: fresh.id });
          return await runPtySession({ ...base, args: fresh.args });
        }
        // A model-scoped limit is remembered against THIS ACCOUNT and handed
        // back to the swap loop, which asks the planner what to do next. It
        // used to be answered here instead, by switching model on the spot,
        // and that answer fired before rotation ever got to choose: running
        // out of Fable on one account moved the whole run to Opus while
        // another account still had Fable. One decision, one place.
        // A hold measured NOTHING, so it must not leave a model claim behind.
        // Inheriting whatever `limitedModel` happened to hold would scope the
        // hold to a model no probe confirmed, leaving the account selectable
        // for everything else and the session parked exactly where it was
        // stuck; and `spentThisRun` would tell the planner that pairing is
        // spent on evidence nobody gathered.
        if (outcome.kind === 'capped' && outcome.unproven) {
          limitedModel = undefined;
          return outcome;
        }
        if (outcome.kind === 'capped' && limitedModel) {
          spentThisRun.add(spentKey(capOwner ?? current?.name ?? account.name, limitedModel));
        }
        return withCapScope(outcome);
      } finally {
        takeScreen(false);
      }
    },
    markCapped: (accountName, reason, resetAt) => recordCap(accountName, reason, resetAt),
    notify: (m) => {
      // NOT stderr: Claude owns the screen while a session runs, so writing
      // there scribbles over the interface. The terminal notification draws
      // nothing, and `ccx history` keeps the record.
      notifyTerminal(`ccx: ${m}`);
      logEvent(m);
    },
    // The ending, which is the opposite situation: no session is running, so
    // the screen is ours and staying quiet tells the operator nothing.
    report: (m) => {
      logEvent(m);
      // Never onto a screen Claude is drawing on: the words land inside its
      // input box looking like something the operator typed, which reads as a
      // live refusal of a session that is in fact running. Held rather than
      // dropped, so it still gets said the moment the terminal comes back.
      screen.say(`ccx: ${m}`);
    },
    knownCappedAccounts: () => [...cappedNames(loadLedger(context.ctx), Date.now())],
  });

  // No more sessions will run: stop watching usage and restore the terminal.
  proactive.stop();
  usageWatch.stop();
  terminalInput.close();
  // The last write of the run: put the child's terminal modes back once more
  // (a flush that landed after the per-session reset can have switched them
  // back on) and say anything still held. After this the shell has the
  // terminal, and it must not be receiving mouse reports as typed text.
  screen.runEnding();
  // On exit, save any refreshed credential back to its account. The session's
  // copy is deliberately LEFT in place: removing it makes anything that looks at
  // this session afterwards report "not logged in", which sends you chasing a
  // sign-in problem that does not exist. The same token already lives in the
  // account folder with the same permissions, so removing it protected nothing.
  // Save the login back, THEN stop protecting it. The other order leaves a window
  // where a renewer rotates the profile and the save then overwrites it with the
  // session's older token, destroying the login it just renewed.
  finishWithLease(announced, {
    saveBack: () => {
      if (current) saveBack(current);
    },
    releaseLease: (name) => releaseLease(name, context.ctx),
  });
  return exitCode;
}
