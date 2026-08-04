/**
 * Deciding when the session's login has already been dealt with.
 *
 * The session's credential is copied back to its account whenever it changes, and
 * working out who it belongs to costs a network call. So each credential is
 * checked once, tracked by a fingerprint of the file.
 *
 * Getting that bookkeeping wrong is expensive in both directions, and both
 * mistakes have now been made here:
 *
 *   Marking only a successful WRITE as handled meant a credential the guard
 *   refused was checked again on the next poll, and the next, twice a second for
 *   the life of the session. It froze the machine and wrote 200 identical log
 *   lines in 104 seconds.
 *
 *   Marking EVERY result as handled would be the opposite mistake: a failed disk
 *   write would never be retried, and a refreshed token could be lost.
 *
 * So the distinction is between a settled ANSWER (written, or refused, neither of
 * which can change until the file does) and a failed ATTEMPT (which might not
 * fail again). Kept here, pure and separate, because a rule this easy to get
 * backwards should be testable on its own.
 */

export type SaveOutcome = 'settled' | 'retry';

export interface MirrorState {
  /** Fingerprint of the credential already dealt with, or '' for none. */
  handled: string;
  /** Fingerprint of a credential whose owner is being looked up right now. */
  checking: string;
}

export const freshMirrorState = (): MirrorState => ({ handled: '', checking: '' });

/**
 * Should the credential with this fingerprint be looked at now?
 *
 * No when there is nothing there, when it has already been dealt with, or when a
 * lookup for that exact credential is already in flight.
 */
export function shouldCheck(state: MirrorState, stamp: string): boolean {
  if (!stamp) return false;
  return stamp !== state.handled && stamp !== state.checking;
}

/** Note that a lookup for `stamp` has begun. */
export function beginCheck(state: MirrorState, stamp: string): MirrorState {
  return { ...state, checking: stamp };
}

/**
 * Record the result of a lookup that finished.
 *
 * A settled result is remembered so the same credential is never checked twice.
 * A retryable one is deliberately forgotten, so a later poll tries again.
 */
export function finishCheck(
  state: MirrorState,
  stamp: string,
  outcome: SaveOutcome,
): MirrorState {
  return {
    handled: outcome === 'settled' ? stamp : state.handled,
    checking: state.checking === stamp ? '' : state.checking,
  };
}

/**
 * Record that a lookup ended without an answer (the API could not be reached).
 *
 * Nothing is settled by that, so the credential stays eligible for another try.
 */
export function abandonCheck(state: MirrorState, stamp: string): MirrorState {
  return { ...state, checking: state.checking === stamp ? '' : state.checking };
}
