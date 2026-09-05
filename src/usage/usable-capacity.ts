import type { UsageEntry } from './usage-store.js';
import { windowIsOpen } from './window-open.js';

/**
 * Reading a cached usage entry as CURRENT capacity rather than as history.
 *
 * The snapshot is a cache, and utilization only climbs while a window is open.
 * The moment a window resets, the stored number is not merely old, it is wrong:
 * it reports "spent" about a limit that has already lifted. Acting on that moves
 * a session off a model it could still be using, and announces a limit that no
 * longer exists.
 *
 * Every stored number carries the time its window resets, so this needs no
 * guess about staleness: a number past its own reset is simply expired.
 */

export interface UsableCapacity {
  /** Per-model utilization, with expired windows left out entirely. */
  models: Record<string, number | null>;
  /** Whether an account-wide window is at its limit and still closed. */
  accountWideOut: boolean;
}

function windowIsOut(
  utilization: number | null | undefined,
  resetsAt: number | null | undefined,
  now: number,
): boolean {
  return typeof utilization === 'number' && utilization >= 1 && windowIsOpen(resetsAt, now);
}

/**
 * The parts of a usage entry this actually reads.
 *
 * Declared structurally rather than as the whole stored entry, so a caller
 * holding the same windows in a different shape does not have to assert its
 * way in. A cast there would keep compiling if the windows were ever dropped,
 * and `accountWideOut` would quietly become false: an account reported as
 * usable when every window on it is spent.
 */
export type CapacityWindows = Pick<
  UsageEntry,
  'fiveHour' | 'sevenDay' | 'fiveHourReset' | 'sevenDayReset'
> &
  Partial<Pick<UsageEntry, 'models'>>;

/** Utilization of a window that is OPEN, else 0 (a reset window is free), else
 *  null when there is no number to read. */
function openWindowUsed(
  utilization: number | null | undefined,
  resetsAt: number | null | undefined,
  now: number,
): number | null {
  if (typeof utilization !== 'number') return null;
  return windowIsOpen(resetsAt, now) ? utilization : 0;
}

/**
 * How much headroom an account has left, as a fraction 0..1 (1 = untouched,
 * 0 = spent), on its BINDING account-wide window: the tighter of the 5-hour and
 * weekly limits. Higher means less used.
 *
 * This is the "how heavily has this account been used overall" metric the
 * least-used ordering sorts by. It is deliberately account-wide, not per-model:
 * which MODEL to run is the planner's job, while this answers which ACCOUNT has
 * the most room to give. An account with no usage read yet counts as fully open
 * (1), so a brand-new or just-reset account is treated as least-used, which is
 * exactly what it is.
 */
export function remainingRoom(entry: CapacityWindows | undefined, now: number): number {
  const used = [
    openWindowUsed(entry?.fiveHour, entry?.fiveHourReset, now),
    openWindowUsed(entry?.sevenDay, entry?.sevenDayReset, now),
  ].filter((u): u is number => u !== null);
  if (used.length === 0) return 1; // unmeasured: treat as least-used
  return Math.max(0, Math.min(1, 1 - Math.max(...used)));
}

/** What an account can still be asked to do, according to `entry`, right now. */
export function usableCapacity(entry: CapacityWindows | undefined, now: number): UsableCapacity {
  const models: Record<string, number | null> = {};
  for (const model of entry?.models ?? []) {
    // Dropping an expired entry makes that model "unmeasured", which the chooser
    // already treats as room worth trying. That is the right answer here: the
    // window reset, so the only honest statement is that we do not know.
    if (windowIsOpen(model.resetsAt, now)) models[model.name] = model.utilization;
  }
  return {
    models,
    accountWideOut:
      windowIsOut(entry?.fiveHour, entry?.fiveHourReset, now) ||
      windowIsOut(entry?.sevenDay, entry?.sevenDayReset, now),
  };
}
