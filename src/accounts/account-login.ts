import { readToken } from '../daemon/token-store.js';
import { hasUsableLogin } from './credential-vault.js';

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
