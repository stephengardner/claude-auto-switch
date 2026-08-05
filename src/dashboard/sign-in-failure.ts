/**
 * What the dashboard says when a sign-in does not get off the ground.
 *
 * Signing in reaches outside the process: it starts a browser, talks to a
 * debug port, and waits on a network. Any of those can throw rather than
 * return a failure, and an error escaping the dashboard's loop ends the whole
 * program with a stack trace. From the operator's side that reads as "pressing
 * l broke my terminal", which is both alarming and the wrong thing to go and
 * investigate.
 *
 * So the error becomes a line on the dashboard instead. Kept as a pure function
 * because the message is the part worth pinning: it has to name the account, so
 * a two-account setup does not leave you guessing which one failed, and it has
 * to carry the reason, or the operator is told something went wrong and nothing
 * about what.
 */

/** The reason out of anything that can be thrown, without ever throwing itself. */
function reasonOf(err: unknown): string {
  // An Error answers for itself, INCLUDING when it has nothing to say. Falling
  // through to String() for a blank one yields the bare word "Error", which
  // reads like a reason and is not one.
  if (err instanceof Error) {
    const message = err.message.trim();
    return message.length > 0 ? message : 'no reason given';
  }
  const text = String(err ?? '').trim();
  // A thrown undefined, or an object that stringifies to nothing useful, would
  // otherwise produce a message with a dangling colon and no reason after it.
  return text.length > 0 && text !== '[object Object]' ? text : 'no reason given';
}

export function signInFailureNotice(account: string, err: unknown): string {
  return `sign-in for "${account}" could not start: ${reasonOf(err)}`;
}
