/**
 * The one rule for deciding whether a recorded usage number still means
 * anything.
 *
 * Usage numbers are cached, and utilization only climbs while a window is open.
 * So a number past its own reset is not merely old, it is wrong in a specific
 * direction: it reports "spent" about a limit that has already lifted. Acting on
 * one sends a session away from an account or a model it could still use, and
 * announces a limit that no longer exists.
 *
 * Staleness cannot be judged by how old the entry is. When a usage probe fails,
 * the last known numbers are deliberately kept rather than blanked, and the
 * fetch time is bumped, so an account whose usage cannot be read at all keeps
 * numbers that LOOK freshly checked forever. The reset time is the only honest
 * signal, and every stored window carries one.
 */

/**
 * Whether a window recorded with this reset time is still in force at `now`.
 *
 * No reset time means no evidence the limit lifted, so the number stands. That
 * is the conservative direction: believing it costs one rotation, ignoring it
 * costs starting a session straight into a limit.
 */
export function windowIsOpen(resetsAt: number | null | undefined, now: number): boolean {
  return typeof resetsAt !== 'number' || resetsAt > now;
}

/**
 * A recorded utilization as it stands NOW.
 *
 * Three states, and conflating any two of them produces a wrong answer:
 * nothing measured is null (and null is not zero), a measured window that has
 * since reset constrains nothing, and a measured window still open keeps its
 * number. The middle case is positive information: the window began again at
 * empty, so it counts as room rather than as an unknown.
 *
 * Takes the two values rather than a window object because the same rule has to
 * serve several shapes: report windows, dashboard rows and policy snapshots.
 */
export function effectiveUtilization(
  used: number | null | undefined,
  resetsAt: number | null | undefined,
  now: number,
): number | null {
  if (typeof used !== 'number') return null;
  return windowIsOpen(resetsAt, now) ? used : 0;
}

/** The two numbers any "which window binds" question needs. */
export interface Measured {
  used: number | null | undefined;
  /** Optional so a caller whose window simply has no reset time still fits. */
  resetsAt?: number | null | undefined;
}

/**
 * Does `b` constrain you more than `a` right now?
 *
 * Used wherever something picks the window closest to its limit. Once expired
 * windows read as empty, TIES are the normal case rather than a corner, so the
 * tie rule decides what gets named most of the time: an open window wins,
 * because an expired one constrains nothing and naming it reports a limit that
 * is not running.
 *
 * Written as a comparator rather than repeated at each call site because the
 * three places that ask this hold their numbers in three different shapes, and
 * the last time the rule was fixed in only one of them the other two kept the
 * bug.
 */
export function bindsHarder(b: Measured, a: Measured, now: number): boolean {
  const usedB = effectiveUtilization(b.used, b.resetsAt, now) ?? 0;
  const usedA = effectiveUtilization(a.used, a.resetsAt, now) ?? 0;
  if (usedB !== usedA) return usedB > usedA;
  return windowIsOpen(b.resetsAt, now) && !windowIsOpen(a.resetsAt, now);
}
