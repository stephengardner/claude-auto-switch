import { readCredential } from '../accounts/credential-storage.js';
import { credentialPath, usableLoginText } from '../accounts/credential-vault.js';
import { loginWasRejected } from '../accounts/account-login.js';
import type { Account } from '../accounts/registry.schema.js';
import type { LendTarget, LendingConfig } from '../config/config.schema.js';
import type { PathCtx } from '../config/paths.js';
import type { LeaseOptions } from '../session/lease.js';
import { identityFields } from '../session/claude-folder.js';
import { refreshCredentialIfExpired, type RefreshOptions } from '../usage/oauth-refresh.js';
import { loginExpiresAt, readExpiresAt } from '../usage/token-expiry.js';
import { renewIdleLogin } from '../usage/usage-store.js';
import { LendError } from '../util/errors.js';
import { buildLendBundle, type LendBundle } from './bundle.js';
import { lentLoginIn } from './lent-login.js';

/**
 * The lending end: what the machine that owns a login sends, and renewing
 * that login ahead of its expiry so what it sends has hours left.
 */

/**
 * The bundle that lends `account`'s login as it is stored now. Lent from the
 * profile, the copy every session's renewal is carried home to. Throws
 * LendError for an account this machine cannot lend: one lent to it, signed
 * out, refused, or holding a token that has already expired.
 */
export function lendBundleFor(account: Account, ctx: PathCtx, now: number): LendBundle {
  const { name } = account;
  if (lentLoginIn(account.dir)) {
    throw new LendError(
      `"${name}" is lent to this machine; only the machine that holds its login can lend it`,
    );
  }
  if (loginWasRejected(account.dir, ctx)) {
    throw new LendError(
      `"${name}" was signed out at Anthropic; sign it in again first (ccx login ${name})`,
    );
  }
  let text: string;
  try {
    text = readCredential(credentialPath(account.dir));
  } catch {
    throw new LendError(`"${name}" has no login here to lend (ccx login ${name})`);
  }
  if (!usableLoginText(text))
    throw new LendError(`"${name}" is not signed in here (ccx login ${name})`);
  if (loginExpiresAt(text) <= now) {
    throw new LendError(
      `"${name}": its stored token has expired; renew it first (ccx renew ${name})`,
    );
  }
  return buildLendBundle({
    account: name,
    ...(account.email ? { email: account.email } : {}),
    credential: text,
    oauthAccount: identityFields(account.dir).oauthAccount,
    now,
  });
}

export type RenewOutcome = 'renewed' | 'fresh' | 'in-use' | 'needs-login' | 'busy' | 'failed';

export interface RenewAheadResult {
  outcome: RenewOutcome;
  /** Why it was not renewed, when that matters. Never a token. */
  detail?: string;
  /** When the stored token expires now, after any renewal; 0 when unknown. */
  expiresAt: number;
}

export interface RenewAheadOptions {
  /** Renew once less than this is left. */
  aheadMs: number;
  /** Renew whatever is left. */
  force?: boolean;
  now?: () => number;
  /** The token endpoint and how it is reached, for tests. */
  refresh?: Pick<RefreshOptions, 'fetchImpl' | 'tokenUrl' | 'clientId' | 'requestTimeoutMs'>;
  leaseOptions?: LeaseOptions;
}

/**
 * Renew `account`'s login now when less than `aheadMs` is left on it, or
 * always with `force`, through the renewal every other part of ccx uses:
 * under the login's lock, read again there, never while a session or the
 * editor is using the login (the renewal would sign it out), and carried to
 * the profiles that share it. So this can never race an ordinary renewal.
 */
export async function renewAhead(
  account: Account,
  accounts: Account[],
  ctx: PathCtx,
  options: RenewAheadOptions,
): Promise<RenewAheadResult> {
  const now = options.now ?? (() => Date.now());
  if (lentLoginIn(account.dir)) {
    throw new LendError(
      `"${account.name}" is lent to this machine; the machine that lends it renews it`,
    );
  }
  const file = credentialPath(account.dir);
  if (!options.force && readExpiresAt(file) - now() > options.aheadMs) {
    return { outcome: 'fresh', expiresAt: readExpiresAt(file) };
  }
  const renewWithinMs = options.force ? Number.POSITIVE_INFINITY : options.aheadMs;
  const { refusal, renewal } = await renewIdleLogin(account, accounts, ctx, {
    ...(options.leaseOptions ? { leaseOptions: options.leaseOptions } : {}),
    renew: (dir) =>
      refreshCredentialIfExpired(dir, { ...options.refresh, ctx, now, renewWithinMs }),
  });
  const expiresAt = readExpiresAt(file);
  if (refusal !== null) return { outcome: 'in-use', detail: refusal, expiresAt };
  switch (renewal.status) {
    case 'refreshed':
      return { outcome: 'renewed', expiresAt };
    case 'not-needed':
      return { outcome: 'fresh', expiresAt };
    case 'needs-login':
      return {
        outcome: 'needs-login',
        detail: renewal.detail ?? 'the token endpoint refused it',
        expiresAt,
      };
    case 'busy':
      return {
        outcome: 'busy',
        detail: renewal.detail ?? 'something else is renewing it',
        expiresAt,
      };
    default:
      return {
        outcome: 'failed',
        detail: renewal.detail ?? `it could not be renewed (${renewal.status})`,
        expiresAt,
      };
  }
}

/**
 * The accounts `target` lends, by name. `explicit` when its config lists them:
 * each is then expected to be lendable, where `all` lends whichever are.
 */
export function targetAccounts(
  target: LendTarget,
  accounts: Account[],
  active: string | null,
): { names: string[]; explicit: boolean } {
  if (target.accounts === 'all' || target.accounts === 'all-except-active') {
    const skipActive = target.accounts === 'all-except-active';
    return {
      names: accounts
        .filter((a) => a.enabled && !(skipActive && a.name === active))
        .map((a) => a.name),
      explicit: false,
    };
  }
  return { names: [...target.accounts], explicit: true };
}

/** A target's own settings where it has them, the section's otherwise, in milliseconds. */
export function targetSettings(
  target: LendTarget,
  lending: LendingConfig,
): { aheadMs: number; marginMs: number } {
  return {
    aheadMs: (target.renewAheadMinutes ?? lending.renewAheadMinutes) * 60_000,
    marginMs: (target.expiryMarginMinutes ?? lending.expiryMarginMinutes) * 60_000,
  };
}
