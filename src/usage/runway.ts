import { normalizeModel } from './model-preference.js';
import { windowIsOpen } from './window-open.js';

/**
 * Which account to move to: the one that can run longest, and among those
 * that can run about as long, the one whose weekly budget would otherwise go
 * unused soonest.
 *
 * An account has several windows at once (the 5-hour one, the weekly one for
 * all models, and a weekly one per model such as Fable), and the one that runs
 * out first stops it. Comparing their percentages directly treats 30% of a week
 * as equal to 30% of a 5-hour window, which is wrong by the number of 5-hour
 * windows a week holds. So every window is measured in one unit, the 5-hour
 * window: how much of a full 5-hour window's work the account can still do
 * before something stops it. That is its RUNWAY, 0 to 1.
 *
 * Weekly room converts into that unit through what one full 5-hour window
 * costs the week on that account, which differs by plan and is learned from
 * the account's own readings (learnWindowCost). So both of these read as
 * almost no runway, which is the point:
 *   - 5-hour window 90% used, weekly barely touched (0.1 of a window left),
 *   - 5-hour window fresh, weekly 99% used (a tenth of a window, at the
 *     default cost).
 *
 * Moving costs something too: the conversation is read again on the new
 * account, without a cache. An account with less than MIN_RUNWAY of a window
 * would spend most of it on that, so it comes after every account that has
 * more, used only when nothing better exists.
 *
 * Between accounts that can run about as long (the same tenth of a window),
 * the one whose leftover weekly budget is most at risk of expiring unused goes
 * first (URGENCY): budget left at the weekly reset is gone, budget elsewhere
 * keeps.
 */

/** What one full 5-hour window costs the week, until an account's own readings say. */
export const DEFAULT_WINDOW_COST = 0.1;
/** Less runway than this is not worth a move (see above). */
export const MIN_RUNWAY = 0.25;

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/** The windows of one account, as the usage store keeps them. */
export interface RunwayWindows {
  fiveHour: number | null;
  sevenDay: number | null;
  fiveHourReset?: number | null;
  sevenDayReset?: number | null;
  models?: Array<{ name: string; utilization: number; resetsAt?: number | null }> | null;
  /** Learned: what one full 5-hour window costs the week on this account. */
  windowCost?: number | null;
}

export interface Standing {
  /** Work left before a window stops it, in full 5-hour windows (0..1). */
  runway: number;
  /** Which window binds: the one with the least room. */
  binding: '5-hour' | 'weekly' | 'model' | 'none';
  /** Weekly budget left, in 5-hour windows of work; null when not measured. */
  weeklyWindowsLeft: number | null;
  /** When the weekly window resets; null when not measured. */
  weeklyResetAt: number | null;
  /** How much of the leftover weekly budget is at risk of expiring unused (0..1). */
  urgency: number;
  /** Enough runway to be worth a move. */
  worthMoving: boolean;
}

/** The cost of a full 5-hour window, kept within sense for a reading gone odd. */
function windowCostOf(entry: RunwayWindows | undefined): number {
  const cost = entry?.windowCost;
  return typeof cost === 'number' && cost > 0 ? Math.min(1, Math.max(0.01, cost)) : DEFAULT_WINDOW_COST;
}

/** Utilization of an open window; a window past its reset is fresh; null when unread. */
function used(utilization: number | null | undefined, resetsAt: number | null | undefined, now: number): number | null {
  if (typeof utilization !== 'number') return null;
  return windowIsOpen(resetsAt, now) ? Math.min(1, Math.max(0, utilization)) : 0;
}

/**
 * Where an account stands for the next move, for `model` when one is known (a
 * model with a weekly window of its own is limited by that too).
 */
export function standingOf(entry: RunwayWindows | undefined, now: number, model?: string | null): Standing {
  const cost = windowCostOf(entry);
  const candidates: Array<{ binding: Standing['binding']; windows: number }> = [];

  const fiveHour = used(entry?.fiveHour, entry?.fiveHourReset, now);
  candidates.push({ binding: '5-hour', windows: fiveHour === null ? 1 : 1 - fiveHour });

  const weekly = used(entry?.sevenDay, entry?.sevenDayReset, now);
  const weeklyWindowsLeft = weekly === null ? null : (1 - weekly) / cost;
  if (weeklyWindowsLeft !== null) candidates.push({ binding: 'weekly', windows: weeklyWindowsLeft });

  if (model) {
    const key = normalizeModel(model);
    const own = (entry?.models ?? []).find((m) => normalizeModel(m.name) === key);
    const modelUsed = own ? used(own.utilization, own.resetsAt, now) : null;
    if (modelUsed !== null) candidates.push({ binding: 'model', windows: (1 - modelUsed) / cost });
  }

  const tightest = candidates.reduce((a, b) => (b.windows < a.windows ? b : a));
  const runway = Math.max(0, Math.min(1, tightest.windows));

  const weeklyResetAt =
    weekly !== null && typeof entry?.sevenDayReset === 'number' && windowIsOpen(entry.sevenDayReset, now)
      ? entry.sevenDayReset
      : null;
  // Budget left at the reset is gone: at risk is how much of what is left
  // could not be used before then even running flat out, 0 when all of it can.
  let urgency = 0;
  if (weeklyWindowsLeft !== null && weeklyResetAt !== null) {
    const windowsOfTime = Math.max(1, (weeklyResetAt - now) / FIVE_HOURS_MS);
    urgency = Math.min(1, weeklyWindowsLeft / windowsOfTime);
  }

  return {
    runway,
    binding: entry ? tightest.binding : 'none',
    weeklyWindowsLeft,
    weeklyResetAt,
    urgency,
    worthMoving: runway >= MIN_RUNWAY,
  };
}

/**
 * One number to sort by, higher first: worth moving at all, then runway in
 * tenths of a window, then urgency. Ties after that fall to the priority order
 * (the comparator), so the order is always fully determined.
 */
export function pickScore(standing: Standing): number {
  return (standing.worthMoving ? 100 : 0) + Math.round(standing.runway * 10) + Math.min(1, standing.urgency) * 0.99;
}

/**
 * Learn what one full 5-hour window costs the week on an account, from two
 * readings inside the same pair of windows: the weekly share used between
 * them, over the 5-hour share used between them. Kept as a running average,
 * so one odd pair cannot swing it. Returns the previous value (or null) when
 * the pair says nothing: different windows, or too little used to measure.
 */
export function learnWindowCost(previous: RunwayWindows | undefined, next: RunwayWindows): number | null {
  const known = typeof previous?.windowCost === 'number' ? previous.windowCost : null;
  if (!previous) return known;
  const same = (a: number | null | undefined, b: number | null | undefined): boolean =>
    typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 60_000;
  if (!same(previous.fiveHourReset, next.fiveHourReset) || !same(previous.sevenDayReset, next.sevenDayReset)) {
    return known;
  }
  if (typeof previous.fiveHour !== 'number' || typeof next.fiveHour !== 'number') return known;
  if (typeof previous.sevenDay !== 'number' || typeof next.sevenDay !== 'number') return known;
  const fiveHourUsed = next.fiveHour - previous.fiveHour;
  const weeklyUsed = next.sevenDay - previous.sevenDay;
  if (fiveHourUsed < 0.05 || weeklyUsed < 0) return known;
  const sample = Math.min(1, Math.max(0.01, weeklyUsed / fiveHourUsed));
  return known === null ? sample : known * 0.7 + sample * 0.3;
}
