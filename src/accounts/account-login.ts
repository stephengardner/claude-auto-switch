import { readToken } from '../daemon/token-store.js';
import { hasUsableLogin, credentialFileFingerprint } from './credential-vault.js';
import { loginIsKnownDead } from '../usage/dead-login-store.js';
import type { PathCtx } from '../config/paths.js';

/**
 * Does this account have something to authenticate with?
 *
 * Two ways in: a usable credentials file, or a stored OAuth token. The second is
 * how macOS accounts work, because credentials live in the Keychain there rather
 * than in a file, so checking only the file would call every macOS account
 * signed out.
 *
 * A signed-out profile keeps a COMPLETE credential file whose token strings are
 * empty, so the file existing is not a login. Picking one starts a session that
 * cannot work and then looks like a usage limit, which sends you off waiting for
 * a reset that was never the problem.
 *
 * Deliberately the NARROW question: is there something to authenticate with, not
 * will it work. It says nothing about whether the token endpoint has since
 * rejected that login, which is a stricter question answered by the dead-login
 * store. The two are kept apart because several callers here run on a timer and
 * need the cheap answer.
 */
export function hasLogin(accountDir: string): boolean {
  return hasUsableLogin(accountDir) || readToken(accountDir) !== null;
}

/**
 * Does this account have a login that has NOT been rejected?
 *
 * The stricter question, and the one to ask when choosing an account to use or
 * reporting which accounts are live. `hasLogin` only says there is something to
 * authenticate with; this also excludes the logins the token endpoint has
 * definitively refused, which no amount of waiting repairs.
 *
 * Not used for the input to a RENEWAL, which deliberately asks the narrow
 * question: the renewal path does its own dead check and produces a better
 * message from it, including the reason the login was refused.
 */
export function hasWorkingLogin(accountDir: string, ctx: PathCtx): boolean {
  if (!hasLogin(accountDir)) return false;
  return !loginWasRejected(accountDir, ctx);
}

/**
 * Has the token endpoint refused THIS exact credential?
 *
 * Separate from `hasWorkingLogin` for the callers that have already established
 * the account is signed in by other means, and only need the part ccx knows.
 * The health probe is one: it asks Claude itself, which can recognise a login
 * that ccx's own file check does not, so narrowing its answer with a second
 * opinion about the file would drop accounts that genuinely work.
 */
export function loginWasRejected(accountDir: string, ctx: PathCtx): boolean {
  return loginIsKnownDead(credentialFileFingerprint(accountDir), ctx);
}
