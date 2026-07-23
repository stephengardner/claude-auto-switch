import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { configHome, type PathCtx } from '../config/paths.js';
import { listAccounts } from '../accounts/registry.js';
import { getActive } from '../state/active.js';
import { loadLedger, saveLedger, markCapped, cappedNames } from '../ledger/ledger.js';
import { readToken } from '../daemon/token-store.js';
import { readReferenceConfig, onboardingFlags } from '../daemon/reference-config.js';
import { runHotSwapSession } from '../launcher/hot-swap.js';
import { runPtySession } from '../launcher/pty-session.js';
import { secureMkdir, writeSecretFile, copySecretFile } from '../util/secret-file.js';
import { appendEvent } from '../events/log.js';
import { getClaude, type CliContext } from '../context.js';
import type { Account } from '../accounts/registry.schema.js';

const CREDS = '.credentials.json';

/** An account is usable if it has a login (a credentials file, or a stored token on macOS). */
function hasLogin(accountDir: string): boolean {
  return existsSync(path.join(accountDir, CREDS)) || readToken(accountDir) !== null;
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
  seedSessionSettings(sessionDir, accounts);
  const err = context.err ?? ((m: string) => process.stderr.write(`${m}\n`));
  const home = configHome(context.ctx);
  // Record events to the shared log so an open `ccx dashboard` shows swaps live.
  const logEvent = (m: string): void => appendEvent(home, m, Date.now());
  const debugLog = process.env.CAS_DEBUG ? path.join(sessionDir, 'session-debug.log') : undefined;

  let current: Account | null = null;

  const saveBack = (account: Account): void => {
    if (!existsSync(sessionCreds)) return;
    try {
      copySecretFile(sessionCreds, path.join(account.dir, CREDS));
    } catch {
      /* best effort: preserve a refreshed token back to the account */
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

  const activate = (account: Account): void => {
    if (current && current.name !== account.name) saveBack(current);
    const src = path.join(account.dir, CREDS);
    // Always replace (or clear) the session credential so one account's login
    // can never linger into another account's session.
    if (existsSync(src)) {
      copySecretFile(src, sessionCreds);
    } else {
      scrubSessionCreds();
    }
    // Stamp the account's identity (oauthAccount/userID) so the interactive app
    // sees a logged-in account instead of prompting for login.
    applyAccountIdentity(sessionDir, account.dir, context.ctx);
    current = account;
  };

  const exitCode = await runHotSwapSession({
    nextAccount: (excluding) => {
      const capped = cappedNames(loadLedger(context.ctx), Date.now());
      const pinned = getActive(context.ctx);
      const eligible = accounts
        .filter((a) => a.enabled && !excluding.has(a.name) && !capped.has(a.name) && hasLogin(a.dir))
        .sort((a, b) => a.priority - b.priority);
      // Start on the pinned account if it is still eligible, else lowest priority.
      const pick = (pinned ? eligible.find((a) => a.name === pinned) : undefined) ?? eligible[0];
      return pick ? { name: pick.name, dir: pick.dir } : null;
    },
    runSession: async (hotAccount, isContinue) => {
      const account = accounts.find((a) => a.name === hotAccount.name);
      if (!account) return { kind: 'ok', exitCode: 1 };
      activate(account);
      const token = readToken(account.dir);
      const env: Record<string, string> = token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
      const base = { claude, configDir: sessionDir, env, ...(debugLog ? { debugLog } : {}) };
      const wantContinue = isContinue && !wantsContinue(args);

      err(`[ccx] session on "${account.name}"`);
      logEvent(`session on ${account.name}`);
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
        }),
        context.ctx,
      );
      logEvent(`${accountName} hit its limit`);
    },
    notify: (m) => {
      err(`[ccx] ${m}`);
      logEvent(m);
    },
  });

  // On exit, save any refreshed credential back to its account and remove the
  // live credential from the shared session dir so nothing is left at rest.
  if (current) saveBack(current);
  scrubSessionCreds();
  return exitCode;
}
