/**
 * A readable reason out of anything that can be thrown, without ever throwing.
 *
 * Two mistakes live here, both made in this codebase before this was shared:
 *
 * An `as Error` cast is a guess. Anything at all can be thrown: a string
 * prints "undefined", and a null throws a TypeError from inside the very
 * handler that exists to keep the program alive.
 *
 * Reading the reason can ITSELF throw. A thrown object can carry a `toString`
 * or `Symbol.toPrimitive` that throws, and the exception then travels straight
 * back out through the recovery path. A formatter that can kill the program it
 * exists to keep alive is the same bug in miniature.
 */
export function thrownReason(err: unknown): string {
  try {
    // An Error answers for itself, INCLUDING when it has nothing to say.
    // Falling through to String() for a blank one yields the bare word
    // "Error", which reads like a reason and is not one.
    if (err instanceof Error) {
      const message = err.message.trim();
      return message.length > 0 ? message : 'no reason given';
    }
    const text = String(err ?? '').trim();
    return text.length > 0 && text !== '[object Object]' ? text : 'no reason given';
  } catch {
    return 'no reason given';
  }
}
