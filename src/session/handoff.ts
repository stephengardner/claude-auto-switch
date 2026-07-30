/**
 * The ORDER in which a session takes over an account, and gives it back.
 *
 * Pulled out of the session command because the order is the whole safety
 * property, and inside a closure it could not be tested: an attempt to check it
 * by watching the filesystem could not tell steps microseconds apart, and passed
 * even with the order reversed. With the steps injected, the sequence itself is
 * what gets asserted.
 *
 * Why each rule exists. Renewing a login REPLACES it, so any moment where a
 * login is in use but not announced is a moment where a renewer can retire the
 * token from under it:
 *
 *   Taking over: announce FIRST, then copy the login in. The other way round
 *   leaves a gap between the copy and the announcement, and a session that starts
 *   in that gap can be holding a token that was retired a moment earlier.
 *
 *   Handing back: save the login FIRST, then drop the announcement. The other way
 *   round leaves a gap where a renewer rotates the profile and the save then
 *   overwrites it with the session's older token, destroying the renewed one.
 *
 * Both rules err towards protecting for slightly too long, which costs nothing:
 * an account that is announced but idle is simply not renewed for a moment.
 */

export interface HandoffSteps {
  takeLease: (account: string) => void;
  releaseLease: (account: string) => void;
  /** Copy the account's login into the shared session folder. May throw. */
  install: () => void;
}

/**
 * Switch the session onto `account`. Returns the account now announced.
 *
 * On failure the announcement is given back (unless we already held it) and the
 * previous one is kept, so a failed switch does not leave the session announcing
 * an account it is not on.
 */
export function activateWithLease(
  account: string,
  previouslyAnnounced: string | null,
  steps: HandoffSteps,
): string {
  steps.takeLease(account);
  try {
    steps.install();
  } catch (err) {
    if (previouslyAnnounced !== account) steps.releaseLease(account);
    throw err;
  }
  // Only now is the previous account genuinely no longer in use.
  if (previouslyAnnounced !== null && previouslyAnnounced !== account) {
    steps.releaseLease(previouslyAnnounced);
  }
  return account;
}

export interface FinishSteps {
  releaseLease: (account: string) => void;
  /** Write the session's (possibly refreshed) login back to the account. */
  saveBack: () => void;
}

/** End the session: save the login back, and only then stop protecting it. */
export function finishWithLease(announced: string | null, steps: FinishSteps): void {
  steps.saveBack();
  if (announced !== null) steps.releaseLease(announced);
}
