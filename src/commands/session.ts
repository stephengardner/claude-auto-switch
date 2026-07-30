import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
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
import { notifyAccountSwitch, notifyTerminal } from '../launcher/notify.js';
import { ensureSharedProjects, mergeUserSettings } from '../session/shared-root.js';
import { probeLimit } from '../usage/limit-probe.js';
import { secureMkdir, writeSecretFile, copySecretFile } from '../util/secret-file.js';
import {
  installCredential,
  rollbackCredential,
  isUsableCredential,
  identityKey,
  sessionIdentityEmail,
  hasUsableLogin,
} from '../accounts/credential-vault.js';
import { decideSaveBack } from '../accounts/save-back.js';
import { takeLease, touchLease, releaseLease } from '../session/lease.js';
import { activateWithLease, finishWithLease } from '../session/handoff.js';
import { withCredentialLock } from '../claude/locks.js';
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

function wantsContinue(args: string[]): boolean {
  return args.includes('--continue') || args.includes('-c');
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
      err(
        '[ccx] limit text on screen, but no account-wide cap is confirmed by the API; not switching. ' +
          'If this is a per-model limit, switch accounts yourself: ccx use <name> (or Enter in ccx dashboard).',
      );
    }
    return verdict === 'limited';
  };

  const saveBack = (account: Account): void => {
    if (!existsSync(sessionCreds)) return;
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
      return;
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
      sessionEmail: sessionIdentityEmail(sessionDir),
      ...(account.email ? { accountEmail: account.email } : {}),
      sessionIdentity: identityKey(sessionDir),
      accountIdentity: identityKey(account.dir),
      accountName: account.name,
    });
    if (!decision.save) {
      err(`[ccx] ${decision.reason}`);
      return;
    }
    try {
      // Keeps the account's previous credential as a rollback cushion.
      installCredential(account.dir, sessionCreds);
    } catch {
      /* best effort: preserve a refreshed token back to the account */
    }
  };

  /**
   * A cheap fingerprint of the session's credential file, so a change can be
   * spotted without reading or parsing it on every tick.
   */
  const credStamp = (): string => {
    try {
      const st = statSync(sessionCreds);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return '';
    }
  };
  /** The fingerprint of the credential we last copied to the profile. */
  let mirroredStamp = '';

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
    const stamp = credStamp();
    if (!stamp || stamp === mirroredStamp) return;
    mirroredStamp = stamp;
    saveBack(account);
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
            mirroredStamp = credStamp();
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
        err(`[ccx] ${reason}; moving to "${account}" before this account runs out`);
        logEvent(`proactive switch to ${account}`);
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
      const pick = (pinned ? eligible.find((a) => a.name === pinned) : undefined) ?? eligible[0];
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
      activate(account);
      // Track the account we are actually on so the editor pointer follows it.
      setActive(account.name, context.ctx);
      syncEditorPointerIfEnabled(context);
      const token = readToken(account.dir);
      const env: Record<string, string> = token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
      // Watch for an operator-requested switch to a DIFFERENT, usable account.
      // Seamless (default) swaps credentials under the running process; 'restart'
      // returns the name so the child is ended and the loop relaunches --continue.
      const switchWatch = (): string | null => {
        // Two housekeeping jobs on the same tick, both about not losing a login:
        // say we are still running (so the no-renew protection stays in force),
        // and copy a token Claude just refreshed back to the profile. Without the
        // copy, the profile keeps the token Claude's refresh already retired, and
        // the NEXT `claude` starts on a dead login and asks you to sign in.
        if (current) {
          touchLease(current.name, context.ctx);
          mirrorSessionLoginToProfile(current);
        }
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
        // Seamless: swap the credential file under the running claude. It re-reads
        // within ~30s (its cache TTL), moving the SAME session to the new account
        // with no restart and nothing lost.
        activate(target);
        setActive(target.name, context.ctx);
        syncEditorPointerIfEnabled(context);
        logEvent(`switching to ${target.name} in place`);
        err(`[ccx] switching to "${target.name}" (no restart; takes effect within ~30s)`);
        notifyAccountSwitch(target.name, 'switched in place');
        return null;
      };
      const base = {
        claude,
        configDir: sessionDir,
        env,
        switchWatch,
        verifyCap,
        input: terminalInput,
        ...(runOptions?.ignoreLimits ? { ignoreLimits: true } : {}),
        ...(debugLog ? { debugLog } : {}),
      };
      const wantContinue = isContinue && !wantsContinue(args);

      err(`[ccx] session on "${account.name}"`);
      logEvent(`session on ${account.name}`);
      // Claude owns the screen from here, so tell the operator through the
      // terminal itself (a notification / title change draws nothing).
      notifyAccountSwitch(account.name, isContinue ? 'continued here' : 'session start');
      const outcome = await runPtySession({
        ...base,
        args: wantContinue ? [...args, '--continue'] : args,
      });
      // If we tried to resume but the new account has no saved conversation,
      // start a fresh session on it instead of dead-ending.
      if (outcome.kind === 'no-conversation') {
        err('[ccx] no conversation to resume on this account; starting fresh');
        return runPtySession({ ...base, args });
      }
      return outcome;
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
