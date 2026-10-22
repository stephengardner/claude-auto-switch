import { readCredential } from '../accounts/credential-storage.js';
import path from 'node:path';
import { acquireLockDir, CREDENTIALS_LOCK_DIR } from '../claude/locks.js';
import { writeCredential, copyCredential } from '../accounts/credential-storage.js';
import { credentialPath, previousCredentialPath, isUsableCredential } from '../accounts/credential-vault.js';
import { renewOneAtATime } from './renew-one-at-a-time.js';
import { sha256Fingerprint } from '../util/fingerprint.js';
import { alreadyRefused, refusalReason, rememberRefused } from './dead-login-memo.js';
import { loginIsKnownDead, deadLoginReason, rememberDeadLogin, forgetDeadLogin } from './dead-login-store.js';
import {
  editorHolding,
  queueEditorCarry,
  replaceFolderLogin,
  retryEditorCarriesSoon,
  type FolderLogin,
} from '../editor/folder-login.js';
import type { PathCtx } from '../config/paths.js';

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

/** The longest a token request may take before the renewal gives up. */
const REQUEST_TIMEOUT_MS = 30_000;

/** `busy`: something else holds the login's lock, so nothing was sent; try again shortly. */
export type RefreshStatus = 'refreshed' | 'not-needed' | 'needs-login' | 'unavailable' | 'busy';

export interface RefreshOutcome {
  status: RefreshStatus;
  detail?: string;
  /**
   * True when this verdict was remembered rather than newly discovered, or
   * came from a renewal another caller started, so a caller can report it once
   * instead of on every check.
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
  /**
   * Where ccx keeps its state, so a refusal is written where a LATER process
   * will find it. Without it the note is skipped rather than written somewhere
   * unintended, which is why nothing here defaults to the real config home.
   */
  ctx?: PathCtx;
  /** How long to wait for the login's lock (default two seconds; 0 only tries it). */
  lockWaitMs?: number;
  /** How long the token request may take (default REQUEST_TIMEOUT_MS). */
  requestTimeoutMs?: number;
  /**
   * How long a renewal whose write into the editor's folder failed keeps
   * trying it before leaving it to the next look (default
   * EDITOR_CARRY_SOON_MS); 0 in a test that waits for that look.
   */
  editorCarrySoonMs?: number;
  /**
   * The fingerprint of an access token the API just turned away (401). The
   * login is then renewed however long its stored expiry says it has left,
   * because that expiry is wrong: the token was revoked, and only the token
   * endpoint can say whether the login behind it is finished. Only while the
   * stored login still holds THAT token: one renewed meanwhile is left alone,
   * as an expired one renewed meanwhile is.
   */
  renewRejected?: string;
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
    oauth = (JSON.parse(readCredential(credentialPath(accountDir))) as Record<string, unknown>)
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
      JSON.parse(readCredential(credentialPath(accountDir))) as Record<string, unknown>
    ).claudeAiOauth as OauthBlock | undefined;
  } catch {
    return false;
  }
  const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : 0;
  if (expiresAt === 0) return false; // nothing to judge; treat as in use
  return expiresAt < now() - graceMs;
}

/**
 * Renew `accountDir`'s token if it is expired (or about to be).
 *
 * One at a time per login in this process: a call for a login already being
 * renewed, from this folder or another profile holding the same login, gets
 * that renewal's outcome (marked `alreadyKnown`) instead of sending the same
 * refresh token again. Other processes are kept apart by Claude's lock.
 */
export async function refreshCredentialIfExpired(
  accountDir: string,
  options: RefreshOptions = {},
): Promise<RefreshOutcome> {
  const now = options.now ?? (() => Date.now());
  // Looked at first without the lock, so a login with nothing to do never waits for it.
  const before = assess(credentialPath(accountDir), now, options.ctx, options.renewRejected);
  if (!before.renew) return before.outcome;
  const login = sha256Fingerprint(before.refreshToken);
  return oneRenewalPerLogin(login, () => {
    // Only with a ctx: without one, ccx's own folders are not to be looked in.
    const editor = options.ctx ? editorHolding(login, options.ctx) : null;
    // Whether the editor holds it cannot be told, so it may: renewing without
    // its lock could spend a token its Claude is renewing, or leave it on one retired.
    if (editor === 'unreadable') {
      return Promise.resolve<RefreshOutcome>({
        status: 'busy',
        detail: "the editor's login could not be read, so nothing was sent",
      });
    }
    return editor ? renewWithEditor(accountDir, options, editor, login) : renewUnderLock(accountDir, options);
  });
}

/**
 * Renew a login the editor's folder holds too: under that folder's lock as well
 * as the profile's, for the whole renewal, and written into the folder before
 * its lock is let go, which is how the old link to the profile kept the two
 * apart. A folder lock held by the editor's Claude means it is renewing the
 * login itself, so nothing is sent.
 *
 * The request gets its usual time: one the server answered but ccx gave up on
 * loses the login with the token it spent. Claude 2.1.302 renews only within 5
 * minutes of expiry (`KC`), ccx 10 minutes ahead (EXPIRY_BUFFER_MS), so on
 * schedule the two never meet. When they do, its refresh tries the lock five
 * times, 1 to 2 s apart, then watches the lock's time for up to 7.5 s; ccx
 * touches its lock every 3 s, so Claude finds it busy, not abandoned, sends
 * nothing and goes on with the token it has, and its next look reads ccx's
 * renewal from the folder.
 */
async function renewWithEditor(
  accountDir: string,
  options: RefreshOptions,
  editor: FolderLogin,
  retired: string,
): Promise<RefreshOutcome> {
  const lock = acquireLockDir(path.join(editor.dir, CREDENTIALS_LOCK_DIR), { waitMs: 0 });
  if (lock.unusable) {
    return { status: 'unavailable', detail: `the editor folder's lock could not be created (${lock.unusable})` };
  }
  if (!lock.held) return { status: 'busy', detail: 'your editor is renewing this login' };
  try {
    const outcome = await renewUnderLock(accountDir, options);
    if (outcome.status === 'refreshed') {
      try {
        replaceFolderLogin(editor, retired, readCredential(credentialPath(accountDir)));
      } catch {
        // The editor is left on the token this renewal retired, which its
        // Claude would send at its own renewal and be signed out. Tried again
        // here for a while, then by whatever of ccx looks next.
        if (options.ctx) {
          queueEditorCarry(options.ctx, retired, accountDir);
          void retryEditorCarriesSoon(options.ctx, options.editorCarrySoonMs);
        }
      }
    }
    return outcome;
  } finally {
    lock.release();
  }
}

const oneRenewalPerLogin = renewOneAtATime();

/** What a stored login says about renewing it: stop with an answer, or renew it. */
type Assessment =
  | { renew: false; outcome: RefreshOutcome }
  | { renew: true; raw: Record<string, unknown>; auth: OauthBlock; refreshToken: string; identity: string };

/**
 * Read `file` and decide whether its login wants renewing: when it is expired
 * or nearly, or when it still holds the access token `rejected` fingerprints.
 */
function assess(file: string, now: () => number, ctx: PathCtx | undefined, rejected?: string): Assessment {
  let raw: Record<string, unknown>;
  let fileText: string;
  try {
    fileText = readCredential(file);
    raw = JSON.parse(fileText) as Record<string, unknown>;
  } catch {
    return { renew: false, outcome: { status: 'unavailable', detail: 'no readable credential' } };
  }
  const oauth = raw.claudeAiOauth as OauthBlock | undefined;
  if (!oauth || typeof oauth !== 'object') {
    return { renew: false, outcome: { status: 'unavailable', detail: 'not an oauth login' } };
  }
  if (!oauth.refreshToken) return { renew: false, outcome: { status: 'needs-login', detail: 'no refresh token stored' } };

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
  const identity = sha256Fingerprint(fileText); // same value credentialFileFingerprint yields
  // Known dead in THIS process, or recorded by an earlier one. The second half
  // is what a fresh start needs: without it every new session spends a request
  // rediscovering a refusal that is already written down.
  if (alreadyRefused(identity) || (ctx && loginIsKnownDead(identity, ctx))) {
    return {
      renew: false,
      outcome: {
        status: 'needs-login',
        detail:
          refusalReason(identity) ??
          (ctx ? deadLoginReason(identity, ctx) : undefined) ??
          'renewal was already refused for this login',
        alreadyKnown: true,
      },
    };
  }

  const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0;
  const turnedAway = rejected !== undefined && !!oauth.accessToken && sha256Fingerprint(oauth.accessToken) === rejected;
  if (expiresAt > now() + EXPIRY_BUFFER_MS && oauth.accessToken && !turnedAway) {
    return { renew: false, outcome: { status: 'not-needed' } };
  }
  return { renew: true, raw, auth: oauth, refreshToken: oauth.refreshToken, identity };
}

/** Renew a login found due for renewal: under its lock, having read it again there. */
async function renewUnderLock(accountDir: string, options: RefreshOptions): Promise<RefreshOutcome> {
  const now = options.now ?? (() => Date.now());
  const file = credentialPath(accountDir);
  const ctx = options.ctx;

  // Renewing rotates the token: the one Claude may be holding stops working the
  // moment ours is issued. Claude coordinates its own renewals through this
  // lock, so we take it too, and we do it for the WHOLE operation (request and
  // write) rather than just the write. Without this, ccx and Claude can renew
  // the same login at the same time and whichever finishes second is left
  // holding a token the server has already retired, which is a sign-in prompt
  // out of nowhere.
  //
  // Never without it: a renewal that cannot get the lock sends nothing. Either
  // something else is renewing this login right now, or the lock folder cannot
  // be made at all (a profile folder ccx may not write in), which no wait cures.
  const lock = acquireLockDir(path.join(accountDir, CREDENTIALS_LOCK_DIR), {
    ...(options.lockWaitMs !== undefined ? { waitMs: options.lockWaitMs } : {}),
  });
  if (lock.unusable) {
    return { status: 'unavailable', detail: `its lock folder could not be created (${lock.unusable})` };
  }
  if (!lock.held) return { status: 'busy', detail: 'something else is renewing this login' };
  try {
    // Read again now the lock is held: whoever held it before may have renewed
    // this login meanwhile, and the token read above is then spent.
    const underLock = assess(file, now, ctx, options.renewRejected);
    if (!underLock.renew) return underLock.outcome;
    return await performRenewal(accountDir, options, underLock);
  } finally {
    lock.release();
  }
}

/** Ask the token endpoint to renew the login just read under the lock, and save the new one. */
async function performRenewal(
  accountDir: string,
  options: RefreshOptions,
  { raw, auth, refreshToken, identity }: Extract<Assessment, { renew: true }>,
): Promise<RefreshOutcome> {
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? fetch;
  const file = credentialPath(accountDir);
  const ctx = options.ctx;
  // Bounded, so a request that never answers cannot hold the lock, and a move
  // waiting on it, for good. Generous, because a renewal the server made but
  // this side gave up on is lost with the token it spent.
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const gaveUp = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () =>
      reject(new Error(`the token endpoint did not answer within ${Math.round(timeoutMs / 1000)}s`)),
    );
  });
  // Handled here so that a deadline nobody is waiting on any more is not an unhandled rejection.
  gaveUp.catch(() => undefined);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const inTime = <T>(step: Promise<T>): Promise<T> => Promise.race([step, gaveUp]);
  try {
    let response: Response;
    try {
      response = await inTime(
        fetchImpl(options.tokenUrl ?? TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: options.clientId ?? CLIENT_ID,
          }),
          signal: controller.signal,
        }),
      );
    } catch (err) {
      return { status: 'unavailable', detail: (err as Error).message };
    }

    if (!response.ok) {
      let body = '';
      try {
        body = (await inTime(response.text())).slice(0, 200);
      } catch {
        /* body is optional context */
      }
      // Ask the operator to sign in again on anything that looks like a rejected
      // login, so a real one is never silently treated as a network blip.
      const dead = /invalid_grant|invalid_request|unauthorized/i.test(body) || response.status === 401;
      const detail = `token endpoint ${response.status}${body ? `: ${body}` : ''}`;
      // REMEMBERING is a stricter question than reporting, and deliberately so.
      // Only invalid_grant means the server has rejected this refresh token
      // itself. `invalid_request` describes a malformed request, which is our bug
      // rather than a finished login, and a bare 401 can be a client-auth or
      // transient failure. Recording either would outlast the moment: the note
      // survives the process and makes the status line say "needs sign-in" until
      // the credential file changes, so a blip would bench a working account
      // until someone signed in again for no reason.
      const refreshTokenRejected = /\binvalid_grant\b/i.test(body);
      if (refreshTokenRejected) {
        rememberRefused(identity, detail);
        // Written down as well, so a later process knows before it acts.
        if (ctx) rememberDeadLogin(identity, detail, ctx);
      }
      return { status: dead ? 'needs-login' : 'unavailable', detail };
    }

    let payload: { access_token?: string; refresh_token?: string; expires_in?: number };
    try {
      payload = (await inTime(response.json())) as typeof payload;
    } catch (err) {
      return { status: 'unavailable', detail: `unreadable token response: ${(err as Error).message}` };
    }
    if (!payload.access_token) return { status: 'unavailable', detail: 'token response had no access token' };

    // Keep the previous generation, then write the renewal atomically. The new
    // refresh token replaces the old one, which the server has now invalidated,
    // so losing this write would lose the account: it happens immediately.
    if (isUsableCredential(file)) {
      try {
        copyCredential(file, previousCredentialPath(accountDir));
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
    writeCredential(file, JSON.stringify(updated));
    // A credential that just renewed is demonstrably alive, so make sure no note
    // says otherwise. It should never be there, and that is the point: this
    // guarantees a stale note can never hold down a login that works.
    if (ctx) forgetDeadLogin(sha256Fingerprint(JSON.stringify(updated)), ctx);
    return { status: 'refreshed' };
  } finally {
    clearTimeout(timer);
  }
}

export const REFRESH_EXPIRY_BUFFER_MS = EXPIRY_BUFFER_MS;
