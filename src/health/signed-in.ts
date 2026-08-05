import { loginWasRejected } from '../accounts/account-login.js';
import type { PathCtx } from '../config/paths.js';

/**
 * Which probed accounts can actually be used.
 *
 * The health probe asks Claude whether a profile looks signed in, and it is the
 * authority on that: it recognises logins ccx's own credential-file check does
 * not, such as a macOS account whose credential lives in the Keychain. So its
 * answer is never narrowed by a second opinion about the file.
 *
 * What it cannot know is that the token endpoint refused that exact credential
 * afterwards. That is the only thing taken away here.
 *
 * One shared answer on purpose. This question was asked in five places from the
 * same expression, and only one of them subtracted refusals, so a login that had
 * been definitively refused still counted as available to `ccx run`, `ccx
 * rotate`, the dashboard and `ccx doctor`.
 */
export function signedInAndNotRejected(
  healths: Array<{ name: string; loggedIn: boolean }>,
  accounts: Array<{ name: string; dir: string }>,
  ctx: PathCtx,
): Set<string> {
  return new Set(
    healths
      .filter((h) => h.loggedIn)
      .map((h) => h.name)
      .filter((name) => {
        const account = accounts.find((a) => a.name === name);
        return !!account && !loginWasRejected(account.dir, ctx);
      }),
  );
}
