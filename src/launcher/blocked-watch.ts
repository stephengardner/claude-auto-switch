/**
 * Whether the SESSION is getting anywhere, asked separately from whether ccx
 * can explain why not.
 *
 * ccx decides "should this session move?" as an AND of about ten guards, each
 * of which resolves uncertainty to "do not move": a probe in flight, a refute
 * backoff, a timebox, a thrown request, no credential, a verdict that is not
 * `limited`, a window that is spent on a model ccx does not believe is running,
 * a limit with no window to explain it. Every one of them is individually
 * right, and the composition is the defect: ccx acts only when ALL of them
 * agree, so teaching it about a new kind of limit can only ever make it LESS
 * willing to act. That is why each fix has held for its own case while the same
 * class of failure kept coming back.
 *
 * Two different questions are tangled together in those guards:
 *
 *   Is this account provably out of room?  Decides what CAP TO WRITE. Strict on
 *   purpose: a cap written wrongly benches an account for hours, and enough of
 *   them make ccx refuse to start at all.
 *
 *   Is this session getting anywhere?  Decides whether to MOVE. Should be
 *   permissive: moving costs one relaunch, and the session continues.
 *
 * The strictness the first question needs was being applied to the second, so a
 * session sat blocked for as long as the operator kept trying while the log
 * filled with reasons not to act. This file is the second question, on its own.
 *
 * It is deliberately ignorant. It sees only that limit-shaped text appeared
 * again, never what any probe concluded, so no guard can veto it. It answers
 * one thing: this session has hit a wall repeatedly, over minutes, and nothing
 * about it has changed.
 */

export interface BlockedWatchOptions {
  /** Distinct episodes before the pattern counts. */
  after?: number;
  /**
   * How far apart the first and last must be.
   *
   * A resumed conversation replays its old cap message within seconds of
   * starting, and the resume picker paints history on screen. Those are bursts.
   * Somebody actually stuck is minutes of recurrence.
   */
  spreadMs?: number;
  /**
   * Nearer than this to the last one and it is the same episode.
   *
   * The terminal repaints its whole frame, so one limit message can match on
   * every render for as long as it is on screen. Counting those would reach any
   * threshold in seconds and turn a single refusal into a rotation.
   */
  minGapMs?: number;
}

export interface BlockedWatch {
  /**
   * Limit-shaped text appeared. Returns true when this session should be
   * treated as blocked, whatever any probe made of it.
   *
   * Resets itself when it says so, so one pattern moves the session once rather
   * than on every render afterwards.
   */
  sawLimitText(now: number): boolean;
  /**
   * Something actually changed: a rotation, a model change, a confirmed cap
   * that was acted on. Whatever pattern was building described the situation
   * before that, so it starts again.
   */
  changed(): void;
  /** Distinct episodes counted so far, for the log. */
  count(): number;
}

export function createBlockedWatch(options: BlockedWatchOptions = {}): BlockedWatch {
  const after = options.after ?? 3;
  const spreadMs = options.spreadMs ?? 2 * 60_000;
  const minGapMs = options.minGapMs ?? 5_000;
  let episodes: number[] = [];

  return {
    sawLimitText(now: number): boolean {
      const last = episodes[episodes.length - 1];
      // The same message still on screen, not a new wall.
      if (last !== undefined && now - last < minGapMs) return false;
      episodes.push(now);
      const first = episodes[0] as number;
      if (episodes.length < after || now - first < spreadMs) return false;
      episodes = [];
      return true;
    },
    changed(): void {
      episodes = [];
    },
    count(): number {
      return episodes.length;
    },
  };
}
