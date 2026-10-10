import type { Refusal, RefusalFollower } from './transcript.js';

/**
 * A say in which refused turns a session's ccx acts on.
 *
 * A refused turn normally means the session's account is out. While the
 * session is on another account for a moment (a page published as its home
 * account), a turn that account refuses says nothing about the session's own,
 * and acting on it would cap the wrong account or move a session that has
 * room.
 */
export interface RefusalGate {
  /** While true, refused turns are not read: they stay in the record until it is not. */
  held(): boolean;
  /** A turn to pass over, by what the record says of it. */
  ignores(refusal: Refusal): boolean;
}

/** `follower`, behind `gate`. */
export function gateRefusals(follower: RefusalFollower, gate: RefusalGate | undefined): RefusalFollower {
  if (!gate) return follower;
  let readable = false;
  return {
    poll(id) {
      // Nothing is read while held, so the next look after it still has all of it.
      if (gate.held()) return { readable, refusals: [], promptAt: null, subagentsWrote: false };
      const news = follower.poll(id);
      readable = news.readable;
      return { ...news, refusals: news.refusals.filter((refusal) => !gate.ignores(refusal)) };
    },
  };
}
