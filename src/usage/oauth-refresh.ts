import { readFileSync } from 'node:fs';
import path from 'node:path';
import { acquireLockDir, CREDENTIALS_LOCK_DIR } from '../claude/locks.js';
import { writeSecretFile, copySecretFile } from '../util/secret-file.js';
import { credentialPath, previousCredentialPath, isUsableCredential } from '../accounts/credential-vault.js';
import { sha256Fingerprint } from '../util/fingerprint.js';
import { alreadyRefused, refusalReason, rememberRefused } from './dead-login-memo.js';

/**
 * Renew an account's access token when it has expired.
 *
 * Why this exists: an access token lasts hours, and Claude renews the one it is
 * actively using. An account you are NOT using goes stale, and a stale token
 * cannot read usage, which would leave the rotation policy blind to exactly the
 * accounts it is supposed to switch to.
 *
 * Treated as a delicate operation, because it is: the renewal returns a NEW
 * refresh token and invalidates the old one, so the result is written
 * immediately and atomically (with the previous generation kept) before this
 * function returns. A rejection that means "this login is finished" is reported
 * as needs-login rather than mutating anything.
 */

const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/** Renew this far ahead of expiry so a session never starts on a dying token. */
const EXPIRY_BUFFER_MS = 10 * 60_000;

export type RefreshStatus = 'refreshed' | 'not-needed' | 'needs-login' | 'unavailable';

export interface RefreshOutcome {
  status: RefreshStatus;
  detail?: string;
  /**
   * True when this verdict was remembered rather than newly discovered, so a
   * caller can report it once instead of on every check.
   */
  alreadyKnown?: true;
}

interface OauthBlock {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  [key: string]: unknown;
}

export interface RefreshOptions {
  now?: () => number;
  fetchImpl?: typeof fetch;
  tokenUrl?: string;
  clientId?: string;
}

/**
 * Is this login expired, or close enough that it would be renewed now?
 *
 * Exported so a caller that must NOT renew (a profile sharing its login with
 * another) can still tell whether a renewal would have happened, and report that
 * once instead of on every check.
 */
export function renewalIsDue(accountDir: string, now: () => number = () => Date.now()): boolean {
  let oauth: OauthBlock | undefined;
  try {
    oauth = (JSON.parse(readFileSync(credentialPath(accountDir), 'utf8')) as Record<string, unknown>)
      .claudeAiOauth as OauthBlock | undefined;
  } catch {
    return false; // nothing readable to renew
  }
  if (!oauth || typeof oauth !== 'object' || !oauth.accessToken) return false;
  const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0;
  return expiresAt <= now() + EXPIRY_BUFFER_MS;
}

/**
 * Has this login been dead long enough that nothing can be using it?
 *
 * Used to decide when it is safe to renew a login ccx does not control (an editor
 * session reads one directly, and ccx cannot see that it is running). A live
 * Claude refreshes its own token within minutes of expiry, so a token that has
 * been expired far longer than that is not being held by anything, and renewing
 * it is both safe and the only way to keep its usage readable.
 */
export function expiredLongerThan(
  accountDir: string,
  graceMs: number,
  now: () => number = () => Date.now(),
): boolean {
  let oauth: OauthBlock | undefined;
  try {
    oauth = (
      JSON.parse(readFileSync(credentialPath(accountDir), 'utf8')) as Record<string, unknown>
    ).claudeAiOauth as OauthBlock | undefined;
  } catch {
    return false;
  }
  const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : 0;
  if (expiresAt === 0) return false; // nothing to judge; treat as in use
  return expiresAt < now() - graceMs;
}

/** Renew `accountDir`'s token if it is expired (or about to be). */
export async function refreshCredentialIfExpired(
  accountDir: string,
  options: RefreshOptions = {},
): Promise<RefreshOutcome> {
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? fetch;
  const file = credentialPath(accountDir);

  let raw: Record<string, unknown>;
  let fileText: string;
  try {
    fileText = readFileSync(file, 'utf8');
    raw = JSON.parse(fileText) as Record<string, unknown>;
  } catch {
    return { status: 'unavailable', detail: 'no readable credential' };
  }
  const oauth = raw.claudeAiOauth as OauthBlock | undefined;
  if (!oauth || typeof oauth !== 'object') return { status: 'unavailable', detail: 'not an oauth login' };
  if (!oauth.refreshToken) return { status: 'needs-login', detail: 'no refresh token stored' };
  // Captured after the checks above so the nested renewal can rely on them.
  const auth: OauthBlock = oauth;
  const refreshToken: string = oauth.refreshToken;

  // A dead grant stays dead until this file changes, and only signing in again
  // changes it. Asking the token endpoint a second time cannot get a different
  // answer, so do not: it costs a request per check and buries the credential
  // log, which is the first thing anyone reads to work out why a login broke.
  //
  // Keyed on the WHOLE file rather than the refresh token alone. Hashing just
  // the token is more precise, since the token is the thing the endpoint
  // rejected, but it fails in the worse direction: a credential repaired in any
  // way that leaves the token in place would stay refused until the process
  // restarted. Re-asking a few times costs a request; being stuck costs a
  // working account.
  const identity = sha256Fingerprint(fileText);
  if (alreadyRefused(identity)) {
    return {
      status: 'needs-login',
      detail: refusalReason(identity) ?? 'renewal already refused for this login',
      alreadyKnown: true,
    };
  }

  const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0;
  if (expiresAt > now() + EXPIRY_BUFFER_MS && oauth.accessToken) {
    return { status: 'not-needed' };
  }

  // Renewing rotates the token: the one Claude may be holding stops working the
  // moment ours is issued. Claude coordinates its own renewals through this
  // lock, so we take it too, and we do it for the WHOLE operation (request and
  // write) rather than just the write. Without this, ccx and Claude can renew
  // the same login at the same time and whichever finishes second is left
  // holding a token the server has already retired, which is a sign-in prompt
  // out of nowhere.
  const lock = acquireLockDir(path.join(accountDir, CREDENTIALS_LOCK_DIR));
  try {
    return await performRenewal();
  } finally {
    lock.release();
  }

  async function performRenewal(): Promise<RefreshOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(options.tokenUrl ?? TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: options.clientId ?? CLIENT_ID,
      }),
    });
  } catch (err) {
    return { status: 'unavailable', detail: (err as Error).message };
  }

  if (!response.ok) {
    let body = '';
    try {
      body = (await response.text()).slice(0, 200);
    } catch {
      /* body is optional context */
    }
    // Only a definitively dead grant means "log in again"; anything else is
    // treated as temporary so a blip never marks a good account as broken.
    const dead = /invalid_grant|invalid_request|unauthorized/i.test(body) || response.status === 401;
    const detail = `token endpoint ${response.status}${body ? `: ${body}` : ''}`;
    // Only a definitively dead grant is worth remembering. A transient failure
    // must stay retryable, or one blip would bench a healthy account until the
    // process restarts.
    if (dead) rememberRefused(identity, detail);
    return { status: dead ? 'needs-login' : 'unavailable', detail };
  }

  let payload: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    payload = (await response.json()) as typeof payload;
  } catch (err) {
    return { status: 'unavailable', detail: `unreadable token response: ${(err as Error).message}` };
  }
  if (!payload.access_token) return { status: 'unavailable', detail: 'token response had no access token' };

  // Keep the previous generation, then write the renewal atomically. The new
  // refresh token replaces the old one, which the server has now invalidated,
  // so losing this write would lose the account: it happens immediately.
  if (isUsableCredential(file)) {
    try {
      copySecretFile(file, previousCredentialPath(accountDir));
    } catch {
      /* the cushion is best effort */
    }
  }
  const updated: Record<string, unknown> = {
    ...raw,
    claudeAiOauth: {
      ...auth,
      accessToken: payload.access_token,
      ...(payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
      ...(payload.expires_in ? { expiresAt: now() + payload.expires_in * 1000 } : {}),
    },
  };
  writeSecretFile(file, JSON.stringify(updated));
  return { status: 'refreshed' };
  }
}

export const REFRESH_EXPIRY_BUFFER_MS = EXPIRY_BUFFER_MS;
