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
