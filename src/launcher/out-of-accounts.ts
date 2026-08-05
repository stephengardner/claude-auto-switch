/**
 * What to say when there is no account left to run on.
 *
 * Three different situations end up here and they need different answers, which
 * is the whole point of this file:
 *
 * - out of room: a reset fixes it on its own, so say when to come back
 * - the login was refused: signing in again fixes it, and no wait ever will
 * - never signed in: signing in fixes it, and "again" would be wrong, because
 *   this account has never worked
 *
 * Telling someone to wait for a reset when the problem is a sign-in is the
 * defect this exists to prevent. It has been fixed on four separate surfaces in
 * this codebase, each time locally, which is why the decision is one pure
 * function here rather than a chain of conditionals at the call site.
 *
 * Groups read name-first ("a, b hit a limit") because up to three of them can
 * appear in one message, and only name-first composes without the sentence
 * turning into a pile of clauses.
 */

export interface OutOfAccounts {
  /** Hit a usage limit. A reset brings these back on its own. */
  capped: string[];
  /** Had a login, and the token endpoint refused it. Needs signing in AGAIN. */
  refused: string[];
  /** No stored login at all. Never worked, so "again" would be a lie. */
  neverSignedIn: string[];
}

/** The message shown when waiting really is the only thing to do. */
const WAIT = 'every account has hit its limit; try again after a reset';

function unique(names: string[]): string[] {
  return [...new Set(names)];
}

function group(names: string[], singular: string, plural: string): string {
  return `${names.join(', ')} ${names.length === 1 ? singular : plural}`;
}

/**
 * The message and nothing else: no formatting, no side effects, so every
 * combination can be read in a test.
 */
export function outOfAccountsMessage(state: OutOfAccounts): string {
  // An account can honestly be in two of these at once. The clearest case: a
  // last-resort account is picked for having ROOM without excluding capped ones,
  // so one that already hit a limit can then be refused, and it would otherwise
  // be announced twice in two different voices.
  //
  // Precedence is by what the operator can act on. A sign-in is a thing to go
  // and do; a limit is a thing to wait out, and waiting is pointless on an
  // account you cannot sign into anyway. So a refused login wins over
  // everything, and never-signed-in wins over capped. Normalised HERE rather
  // than at the call site, because the whole point of this function is that one
  // place decides what the ending says.
  const refused = unique(state.refused);
  const neverSignedIn = unique(state.neverSignedIn).filter((n) => !refused.includes(n));
  const capped = unique(state.capped).filter(
    (n) => !refused.includes(n) && !neverSignedIn.includes(n),
  );
  const needsSignIn = [...refused, ...neverSignedIn];

  // Nothing anyone can act on right now, so the only useful thing is when to
  // come back. Deliberately unchanged from what it has always said.
  if (needsSignIn.length === 0) return WAIT;

  const sentences: string[] = [];
  if (capped.length > 0) sentences.push(group(capped, 'hit a limit', 'hit a limit'));
  if (refused.length > 0) {
    sentences.push(group(refused, 'needs signing in again', 'need signing in again'));
  }
  if (neverSignedIn.length > 0) {
    sentences.push(group(neverSignedIn, 'is not signed in yet', 'are not signed in yet'));
  }
  // Only worth saying when waiting is on the table at all. Without a capped
  // account nobody is thinking about a reset, and the line would be noise.
  if (capped.length > 0) sentences.push('A reset will not fix a sign-in');

  return `${sentences.join('. ')}. Run: ccx login ${needsSignIn[0]}`;
}
