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

/** What an account can still be asked to do, according to `entry`, right now. */
export function usableCapacity(entry: UsageEntry | undefined, now: number): UsableCapacity {
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
