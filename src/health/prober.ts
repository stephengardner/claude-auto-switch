import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runCapture } from '../util/exec.js';
import { ACCOUNT_ENV } from '../launcher/child-env.js';
import { parseAuthStatus, type Health } from './auth-status.js';
import { invokerArgs, type ClaudeInvoker } from '../invoker.js';
import { holdsDefaultLogin, readCredentialSteps } from '../accounts/credential-storage.js';
import { credentialPath, usableLoginText } from '../accounts/credential-vault.js';
import { keychainOnTimers } from '../accounts/keychain-view.js';
import { runOnTimers } from '../util/steps.js';

/** Minimal account shape the prober needs (registry Account satisfies this). */
export interface ProbeableAccount {
  name: string;
  dir: string;
}

export interface ProbeResult extends Health {
  name: string;
  checkedAt: number;
  /** Set when auth status could not be parsed; the account is treated logged out. */
  error?: string;
}

export interface ProberDeps {
  claude: ClaudeInvoker;
  /** Injectable clock so `checkedAt` is deterministic in tests. */
  now?: () => number;
}

/** Probe one account's health via `claude auth status`. Never spends model tokens. */
export async function probe(account: ProbeableAccount, deps: ProberDeps): Promise<ProbeResult> {
  const now = deps.now ?? (() => Date.now());
  if (holdsDefaultLogin(account.dir)) return probeHolder(account, now);
  const argv = invokerArgs(deps.claude, ['auth', 'status']);
  const result = await runCapture(deps.claude.bin, argv, {
    env: { CLAUDE_CONFIG_DIR: account.dir },
    // The login in the account's folder, as ccx will launch it: a token in
    // the shell would answer for an account whose folder has none.
    dropEnv: ACCOUNT_ENV,
  });
  try {
    const health = parseAuthStatus(result.stdout);
    return { name: account.name, checkedAt: now(), ...health };
  } catch (err) {
    return {
      name: account.name,
      checkedAt: now(),
      loggedIn: false,
      error: (err as Error).message,
    };
  }
}

/**
 * An account whose login sits in Claude's default login (chat mode), which a
 * Claude on its own folder cannot see: its login read where ccx keeps it,
 * off the thread, and who it is from its folder's state.
 */
async function probeHolder(account: ProbeableAccount, now: () => number): Promise<ProbeResult> {
  let login: string | null;
  try {
    login = await runOnTimers(readCredentialSteps(credentialPath(account.dir), keychainOnTimers));
  } catch {
    login = null;
  }
  let identity: { emailAddress?: unknown; organizationName?: unknown } | undefined;
  let plan: unknown;
  try {
    identity = (JSON.parse(readFileSync(path.join(account.dir, '.claude.json'), 'utf8')) as { oauthAccount?: typeof identity })
      .oauthAccount;
  } catch {
    /* who it is is optional */
  }
  try {
    plan = (JSON.parse(login ?? '') as { claudeAiOauth?: { subscriptionType?: unknown } }).claudeAiOauth?.subscriptionType;
  } catch {
    /* so is its plan */
  }
  return {
    name: account.name,
    checkedAt: now(),
    loggedIn: login !== null && usableLoginText(login),
    ...(typeof identity?.emailAddress === 'string' ? { email: identity.emailAddress } : {}),
    ...(typeof identity?.organizationName === 'string' ? { orgName: identity.organizationName } : {}),
    ...(typeof plan === 'string' ? { plan } : {}),
  };
}

/** Probe many accounts in parallel. */
export async function probeAll(
  accounts: ProbeableAccount[],
  deps: ProberDeps,
): Promise<ProbeResult[]> {
  return Promise.all(accounts.map((account) => probe(account, deps)));
}
