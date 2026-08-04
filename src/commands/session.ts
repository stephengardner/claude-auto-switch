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
} from '../ledger/ledger.js';
import { readToken } from '../daemon/token-store.js';
import { readReferenceConfig, onboardingFlags } from '../daemon/reference-config.js';
import { runHotSwapSession } from '../launcher/hot-swap.js';
import { runPtySession } from '../launcher/pty-session.js';
import { openTerminalInput } from '../launcher/terminal-input.js';
import {
  notifyAccountSwitch,
  notifyTerminal,
  setTerminalOwnedElsewhere,
} from '../launcher/notify.js';
import { ensureSharedProjects, mergeUserSettings } from '../session/shared-root.js';
import { probeLimit } from '../usage/limit-probe.js';
import { readUsageSnapshot } from '../usage/usage-store.js';
import { chooseAccountForModel, modelChangeMessage } from '../usage/model-preference.js';
import { withModel, modelInArgs } from '../usage/model-args.js';
import { wantsContinue, withoutContinue } from '../launcher/continue-args.js';
import { secureMkdir, writeSecretFile, copySecretFile } from '../util/secret-file.js';
import {
  installCredential,
  rollbackCredential,
  isUsableCredential,
  identityKey,
  sessionIdentityEmail,
  hasUsableLogin,
  credentialFingerprint,
} from '../accounts/credential-vault.js';
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
import { withCredentialLock, withCredentialLockIfFree } from '../claude/locks.js';
import { logCredentialEvent } from '../accounts/credential-log.js';
import { appendEvent } from '../events/log.js';
import { getClaude, type CliContext } from '../context.js';
import type { Account } from '../accounts/registry.schema.js';

const CREDS = '.credentials.json';

/** An account is usable if it has a login (a credentials file, or a stored token on macOS). */
function hasLogin(accountDir: string): boolean {
  // A signed-out profile keeps a complete credential file with empty tokens, so
  // file presence is not a login. Selecting one starts a session that cannot
  // work and then looks like a usage limit.
  return hasUsableLogin(accountDir) || readToken(accountDir) !== null;
}

/** True when at least one account can run (hot-swap is possible). */
export function hasAnyUsableAccount(context: CliContext): boolean {
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
 * the conversation (so `--continue` finds it across swaps); each swap copies the
 * chosen account's credential file into that dir (and copies the live,
 * possibly-refreshed credential back out first, so nothing is lost). This uses
 * the logins you already have, with no tokens, on Windows and Linux.
 */
export async function runInteractiveHotSwap(context: CliContext, args: string[]): Promise<number> {
  const accounts = listAccounts(context.ctx);
  const claude = getClaude(context);
  const sessionDir = path.join(configHome(context.ctx), 'session');
  secureMkdir(sessionDir);
  const sessionCreds = path.join(sessionDir, CREDS);
  // Share the user's REAL ~/.claude session/memory store (projects) so /resume
  // and project memories are complete and identical in ccx sessions and plain
  // `claude` alike. Self-heals each start; skips safely if files are busy.
  ensureSharedProjects(sessionDir, context.ctx);
  seedSessionSettings(sessionDir, accounts);
  // Bring in the user's real settings (hooks, permissions), session keys winning.
  mergeUserSettings(sessionDir, context.ctx);
  // Drop any stale switch request so a fresh session starts on the active account
  // and only a NEW mid-session pick triggers an in-place swap.
  clearSwitchRequest(context.ctx);
  const err = context.err ?? ((m: string) => process.stderr.write(`${m}\n`));
  const home = configHome(context.ctx);
  // Record events to the shared log so an open `ccx dashboard` shows swaps live.
  const logEvent = (m: string): void => appendEvent(home, m, Date.now());
  const debugLog = process.env.CAS_DEBUG ? path.join(sessionDir, 'session-debug.log') : undefined;

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
   * Tell the operator something, by whichever channel does not wreck the screen.
   *
   * While a session runs that means the terminal's own notification and title,
   * which draw nothing, plus the event log that `ccx dashboard` and `ccx history`
   * read. Between sessions, when nothing owns the screen, plain stderr.
   */
  const notice = (message: string): void => {
    // While Claude owns the terminal this goes to the LOG and nowhere else.
    // Writing anything, even an escape sequence that renders nothing, pushes
    // bytes into a terminal that is mid-draw and corrupts what is on screen.
    // `ccx dashboard` and `ccx history` are where these are read.
    logEvent(message);
    if (!claudeOwnsScreen) err(`[ccx] ${message}`);
  };

  /** Claude has the terminal from here; ccx stays off it until told otherwise. */
  const takeScreen = (owned: boolean): void => {
    claudeOwnsScreen = owned;
    setTerminalOwnedElsewhere(owned);
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
  let limitedModel: string | undefined;

  // Ground-truth cap check: rendered text only TRIGGERS this; the API decides.
  // Uses the SESSION credential (the live, possibly-refreshed token).
  const verifyCap = async (renderedText: string): Promise<boolean> => {
    let verdict: string;
    if (context.verifyCap) {
      verdict = await context.verifyCap(renderedText);
    } else {
      const probe = await probeLimit(sessionCreds, renderedText);
      verdict = probe.verdict;
      limitedModel = probe.limitedModel;
    }
    if (verdict !== 'limited') {
      // This fires whenever limit-looking text renders and the API refutes it,
      // which includes a conversation that merely TALKS about rate limits. Far
      // too noisy for the screen; the log is where it belongs.
      notice(
        'limit text on screen, but no account-wide cap is confirmed; not switching. ' +
          'For a per-model limit, switch yourself: ccx use <name>',
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
    try {
      // Keeps the account's previous credential as a rollback cushion.
      installCredential(account.dir, sessionCreds);
      return 'settled';
    } catch {
      // A local write failure, not a decision. It might not repeat, and giving
      // up here would leave a refreshed token unsaved until the process exits.
      return 'retry';
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

  // Claim the operator's keyboard once for the whole run; every session in the
  // swap loop borrows it, so terminal mode is never toggled mid-swap.
  const terminalInput = openTerminalInput();

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

      // Prefer an account that still has room on the MODEL in use. A per-model
      // limit stops that model, not the account, so rotating to one whose Fable
      // is also spent solves nothing. Only when no account has any is the model
      // changed, and then in the configured order.
      const rotation = context.config.rotation;
      const model = chosenModel ?? sessionModel(sessionDir, args);
      // Only when a model is actually in play. With nothing pinned, Claude picks
      // its own default and ccx cannot read it, so choosing an account for some
      // preference model's headroom would pick on one model and run another.
      // Imposing the preference instead would silently change everyone's model,
      // which nobody asked for. Plain account rotation is the honest answer.
      if (rotation.preferSameModel && model && ordered.length > 0) {
        const snapshot = readUsageSnapshot(context.ctx);
        const choice = chooseAccountForModel(
          model,
          ordered.map((a) => {
            const u = snapshot.accounts[a.name];
            // An account-wide window at its limit makes every model unusable, so
            // it has to be part of the candidate. Reading only per-model numbers
            // would offer an account that is out altogether.
            const wideOut =
              (typeof u?.fiveHour === 'number' && u.fiveHour >= 1) ||
              (typeof u?.sevenDay === 'number' && u.sevenDay >= 1);
            return {
              name: a.name,
              models: Object.fromEntries((u?.models ?? []).map((m) => [m.name, m.utilization])),
              ...(wideOut ? { accountWideOut: true } : {}),
            };
          }),
          rotation.modelPreference,
        );
        if (choice) {
          const picked = ordered.find((a) => a.name === choice.account);
          if (picked) {
            // Remembered so the session is actually STARTED on it. Choosing a
            // model and not applying it is worse than not choosing: the session
            // keeps running the one that just ran out while the operator has
            // been told it moved.
            if (choice.changedModel) {
              chosenModel = choice.model;
              notice(modelChangeMessage(choice, model));
            }
            return { name: picked.name, dir: picked.dir };
          }
        }
      }

      const pick = ordered[0];
      return pick ? { name: pick.name, dir: pick.dir } : null;
    },
    resolveAccount: (name) => {
      const a = accounts.find((x) => x.name === name);
      return a && hasLogin(a.dir) ? { name: a.name, dir: a.dir } : null;
    },
    // The account the session is ACTUALLY on right now (may have moved via a
    // seamless swap), so a cap is attributed to the right account.
    currentAccount: () => current?.name ?? '',
    // Every account has hit a limit. If those limits are about ONE MODEL, the
    // session still works on another model, so start it and say which model is
    // out. Refusing here is what made a Fable limit look like being signed out.
    lastResort: () => {
      const limit = modelOnlyLimit(loadLedger(context.ctx), Date.now());
      if (!limit) return null;
      const usable = accounts.filter((a) => a.enabled && hasLogin(a.dir));
      const pick = usable.find((a) => a.name === getActive(context.ctx)) ?? usable[0];
      if (!pick) return null;
      const when = limit.resetsAt
        ? ` It frees up ${new Date(limit.resetsAt).toLocaleString()}.`
        : '';
      return {
        account: { name: pick.name, dir: pick.dir },
        message:
          `every account is out of ${limit.model}, but nothing else is limited.` +
          `${when} Starting on "${pick.name}" anyway: switch models with /model to keep working.`,
      };
    },
    runSession: async (hotAccount, isContinue, runOptions) => {
      const account = accounts.find((a) => a.name === hotAccount.name);
      if (!account) return { kind: 'ok', exitCode: 1 };
      // Check the login BEFORE copying it into the session. A login that merely
      // expired is renewed here, which is safe precisely because nothing is using
      // this account yet, and a login that is genuinely finished is named, with
      // the command that fixes it, rather than turning into Claude saying you are
      // logged out for no visible reason.
      const readiness = await ensureLoginUsable({
        hasLogin: () => hasLogin(account.dir),
        renewalDue: () => renewalIsDue(account.dir),
        renew: () => refreshCredentialIfExpired(account.dir),
      });
      if (readiness.state === 'renewed') {
        logCredentialEvent(
          {
            account: account.name,
            kind: 'renewed',
            detail: 'expired login renewed before starting',
          },
          context.ctx,
        );
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
      // returns the name so the child is ended and the loop relaunches --continue.
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
        if (request?.mode === 'restart') return target.name; // end child, relaunch --continue
        // Seamless only when the target's login is usable right now. This swap is
        // synchronous, so there is no chance to renew anything first, and swapping
        // in an expired login lands the running session on a dead token. When it
        // needs work, relaunch instead: --continue keeps the same conversation and
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
      const wantContinue = isContinue && !wantsContinue(args);

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
        const modelArgs = chosenModel ? withModel(args, chosenModel) : args;
        const outcome = await runPtySession({
          ...base,
          args: wantContinue ? [...modelArgs, '--continue'] : modelArgs,
        });
        // If we tried to resume but the new account has no saved conversation,
        // start a fresh session on it instead of dead-ending.
        if (outcome.kind === 'no-conversation') {
          notice('no conversation to resume on this account; starting fresh');
          // modelArgs, not args: this account was chosen for its room on the
          // CHOSEN model, so a fresh start on the old one would walk straight
          // back into the limit we just rotated away from. And drop the resume
          // flag the operator may have typed, or "fresh" would just repeat the
          // resume that found nothing.
          return await runPtySession({ ...base, args: withoutContinue(modelArgs) });
        }
        return outcome;
      } finally {
        takeScreen(false);
      }
    },
    markCapped: (accountName, reason, resetAt) => {
      saveLedger(
        markCapped(loadLedger(context.ctx), {
          account: accountName,
          now: Date.now(),
          resetAt: resetAt ?? null,
          backoffMinutes: context.config.rotation.defaultBackoffMinutes,
          reason,
          ...(limitedModel ? { model: limitedModel } : {}),
        }),
        context.ctx,
      );
      logEvent(`${accountName} hit its limit`);
    },
    notify: (m) => {
      // NOT stderr: Claude owns the screen while a session runs, so writing
      // there scribbles over the interface. The terminal notification draws
      // nothing, and `ccx history` keeps the record.
      notifyTerminal(`ccx: ${m}`);
      logEvent(m);
    },
  });

  // No more sessions will run: stop watching usage and restore the terminal.
  proactive.stop();
  terminalInput.close();
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
