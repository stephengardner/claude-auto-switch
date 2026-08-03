/**
 * Deciding whether a session's login may be written back to a profile.
 *
 * A session's login is saved back so a token renewed mid-session is not lost.
 * That write is only safe when the session is still the SAME account as the
 * profile: otherwise it puts one account's login into another profile, which is
 * how profiles end up scrambled, or two of them end up sharing one login.
 *
 * Pure and separate from the session command so it can be tested directly. It
 * was a closure with no tests, and a gap in it (a session with an address and a
 * profile without one satisfied neither check, so nothing was verified) survived
 * exactly because there was nothing to write a test against.
 */

export interface SaveBackInput {
  /** The account the session is logged in as right now, per its config. */
  sessionEmail: string | null;
  /** The address recorded for this profile when it was registered. */
  accountEmail?: string;
  /** Fuller identity of the session (uuid + email + org), when available. */
  sessionIdentity: string | null;
  /** Fuller identity recorded in the profile's own config. */
  accountIdentity: string | null;
  accountName: string;
}

export type SaveBackDecision = { save: true } | { save: false; reason: string };

/**
 * May this session's login be written into the profile?
 *
 * Two comparisons, in order of trust. The registered address is preferred
 * because it does not drift; the profile's own config can already be wrong by
 * the time it is read. Falls through to the fuller identity comparison whenever
 * the address comparison could not be made, rather than only when the session
 * has no address.
 *
 * Unknown REFUSES. This used to allow the write, on the reasoning that refusing
 * would throw away renewed tokens. That reasoning was wrong, and the operator
 * paid for it: running /login inside a session writes the new credential into the
 * shared session folder, and the identity file Claude keeps beside it is not
 * updated at the same instant. The copy back therefore compared a stale identity,
 * found nothing to disagree with, and wrote the NEW account's login into the OLD
 * account's profile. Two profiles ended up holding one account, their stored
 * limits were then read from the wrong place, and the operator was capped out of
 * accounts that had room.
 *
 * The trade is not symmetric. Refusing loses a refreshed token, which the next
 * sign-in restores. Allowing overwrites a login with someone else's, which
 * silently corrupts the account map and cannot be undone from local state. So
 * anything short of a positive match is refused.
 */
export function decideSaveBack(input: SaveBackInput): SaveBackDecision {
  const { sessionEmail, accountEmail, sessionIdentity, accountIdentity, accountName } = input;

  if (sessionEmail && accountEmail) {
    if (sessionEmail.toLowerCase() !== accountEmail.toLowerCase()) {
      return {
        save: false,
        reason:
          `this session is signed in as ${sessionEmail}, not "${accountName}" (${accountEmail}); ` +
          "leaving that account's stored login untouched",
      };
    }
    return { save: true };
  }

  if (sessionIdentity && accountIdentity) {
    return sessionIdentity === accountIdentity
      ? { save: true }
      : {
          save: false,
          reason: `session is now a different account than "${accountName}"; not overwriting its login`,
        };
  }

  return {
    save: false,
    reason:
      `cannot confirm this session is still "${accountName}", so its stored login is left ` +
      'alone. Signing in as a different account mid-session is exactly when this matters',
  };
}
