import { configHome, type PathCtx } from '../config/paths.js';
import { appendEvent } from '../events/log.js';
import { deadLoginReason } from '../usage/dead-login-store.js';
import { probeUsage, readOauthToken, type LimitProbeResult } from '../usage/limit-probe.js';
import { refreshCredentialIfExpired, type RefreshOutcome } from '../usage/oauth-refresh.js';
import { sha256Fingerprint } from '../util/fingerprint.js';
import { credentialFileFingerprint, credentialPath } from './credential-vault.js';

/**
 * Asking Anthropic whether a stored login still works, rather than looking at it.
 *
 * Everything else ccx knows about a login is local. `claude auth status` says
 * a login is there, and the stored expiry says how long it has. Neither can
 * see the login being revoked: signed out at claude.ai, its token replaced, or
 * the account put on hold. Such a login looks signed in for hours, rotation
 * keeps choosing it, and the first anyone hears of it is Claude saying "Please
 * run /login" in the middle of a session.
 *
 * So: read the account's usage with its token, which costs no tokens. If that
 * is answered, the login works. If the token is turned away (401), only the
 * token endpoint can say whether the login behind it is finished, so the login
 * is renewed, that token and no other. A refusal there is final, and is written
 * down where every part of ccx that asks about logins already looks
 * (`loginWasRejected`), which is what takes the account out of rotation.
 */

export type LoginCheck =
  /** Its usage was read. */
  | { state: 'works' }
  /** Its token had been turned away, and renewing it worked. */
  | { state: 'renewed' }
  /** The token endpoint refused it. `onHold`: because Anthropic put the account on hold. */
  | { state: 'finished'; detail: string; onHold: boolean }
  /** Nothing could be learned (offline, asked to slow down, the login changed meanwhile). */
  | { state: 'unknown'; detail: string };

export interface LoginCheckDeps {
  probe?: (credentialsFile: string) => Promise<LimitProbeResult>;
  /** Renew the login in `dir`, for the access token `rejected` fingerprints. */
  renew?: (dir: string, rejected: string) => Promise<RefreshOutcome>;
  /**
   * Claude was just refused with this login ("Please run /login"), which is
   * the API turning its access token away already. The login is then renewed
   * for the token it holds whenever the usage read cannot say otherwise, and
   * without the usage read at all when Claude said the token had `expired`:
   * that endpoint is often rate limited, and only the token endpoint can say
   * whether an expired token's login is finished.
   */
  refused?: { expired: boolean };
}

/** Ask about the login stored in `dir` (a profile, or a session's own copy). */
export async function askAboutLogin(dir: string, deps: LoginCheckDeps & { ctx?: PathCtx } = {}): Promise<LoginCheck> {
  const probe = deps.probe ?? ((file: string) => probeUsage(file));
  const renew =
    deps.renew ??
    ((accountDir: string, rejected: string) =>
      refreshCredentialIfExpired(accountDir, { renewRejected: rejected, ...(deps.ctx ? { ctx: deps.ctx } : {}) }));

  let rejected: { message: string; token: string } | null = null;
  if (!deps.refused?.expired) {
    let read: LimitProbeResult | null = null;
    let unread: string;
    try {
      read = await probe(credentialPath(dir));
      unread = read.detail ?? 'usage could not be read';
    } catch (err) {
      unread = (err as Error).message;
    }
    if (read && read.verdict !== 'unknown') return { state: 'works' };
    if (read?.rejected) rejected = read.rejected;
    else if (!deps.refused) return { state: 'unknown', detail: unread };
  }
  if (rejected === null) {
    const held = readOauthToken(credentialPath(dir));
    if (!held) return { state: 'unknown', detail: 'it holds no access token to renew' };
    rejected = { message: 'Claude was refused with this login', token: sha256Fingerprint(held) };
  }

  let renewal: RefreshOutcome;
  try {
    renewal = await renew(dir, rejected.token);
  } catch (err) {
    return { state: 'unknown', detail: (err as Error).message };
  }
  switch (renewal.status) {
    case 'refreshed':
      return { state: 'renewed' };
    case 'needs-login': {
      const detail = renewal.detail ?? rejected.message;
      return { state: 'finished', detail, onHold: isOnHold(detail) };
    }
    default:
      return { state: 'unknown', detail: renewal.detail ?? `the login could not be renewed (${renewal.status})` };
  }
}

/**
 * Whether the token endpoint's refusal says the account is on hold, as it did
 * for a restricted account: invalid_grant, "account_on_hold", and a link to
 * claude.ai/restricted. Signing in again does not fix that, which is why it is
 * told apart from an ordinary sign-out.
 */
export function isOnHold(detail: string | undefined): boolean {
  return !!detail && /account_on_hold|claude\.ai\/restricted/i.test(detail);
}

/** Whether the login stored in `dir` was refused because the account is on hold. */
export function loginOnHold(dir: string, ctx: PathCtx): boolean {
  return isOnHold(deadLoginReason(credentialFileFingerprint(dir), ctx));
}

/**
 * Say, where the dashboard's recent lines and `ccx history` show it, that an
 * account's login was found finished and the account is out of rotation.
 */
export function reportFinishedLogin(account: string, check: { detail: string; onHold: boolean }, ctx: PathCtx): void {
  appendEvent(
    configHome(ctx),
    check.onHold
      ? `"${account}" is on hold at Anthropic (claude.ai/restricted), so it is out of rotation`
      : `"${account}" was signed out, so it is out of rotation until it is signed in again`,
    Date.now(),
    { kind: 'signed-out', data: { account, onHold: check.onHold } },
  );
}
