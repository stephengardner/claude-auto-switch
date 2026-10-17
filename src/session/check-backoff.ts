/**
 * How long refused turns go unasked about after a check that did not confirm
 * a limit. Claude refuses every turn the person tries, and each check spends
 * the usage endpoint's budget, which every session on the machine shares, so
 * one the check found no limit behind is not asked about again at once. A
 * refusal that comes meanwhile is kept, and asked about when Claude exits.
 */
export const REFUTE_BACKOFF_MS = 20_000;

/** When refused turns may be asked about again. */
export interface CheckBackoff {
  /** Whether a refusal seen at `now` is to wait. */
  paused(now: number): boolean;
  /** Ask nothing for a while from `now`: a check did not confirm a limit, or a move has just been made. */
  pause(now: number): void;
}

export function createCheckBackoff(ms: number = REFUTE_BACKOFF_MS): CheckBackoff {
  let until = 0;
  return {
    paused: (now) => now < until,
    pause: (now) => {
      until = now + ms;
    },
  };
}
