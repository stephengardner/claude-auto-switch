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
 * An account whose week is nearly spent is HELD BACK: it comes after every
 * account that is not, among those worth moving to, however fresh its 5-hour
 * window. Runway alone tops out at one window, so a fresh window on a week with
 * 11% left scored the same as a fresh window on an untouched week, and the
 * nearly spent one could be picked second. Holding it back is right for three
 * reasons: what is left of it is the least certain number on the screen (the
 * window cost is an estimate, and a small remainder magnifies its error), a
 * second session landing on it drains it twice as fast, and kept for last it is
 * still there to bridge the hours when every healthy account is waiting on its
 * 5-hour window.
 *
 * Between accounts that can run about as long (the same tenth of a window),
 * the one whose leftover weekly budget is most at risk of expiring unused goes
 * first (URGENCY): budget left at the weekly reset is gone, budget elsewhere
 * keeps.
 */

/**
 * What one full 5-hour window costs the week, until an account's own readings
 * say. Measured accounts cost 0.145 to 0.21 of a week per window; 0.1 read a
 * nearly spent week as a full window more often than it held one.
 */
export const DEFAULT_WINDOW_COST = 0.15;
/** Less runway than this is not worth a move (see above). */
export const MIN_RUNWAY = 0.25;
/** A week at least this full holds an account back (rotation.holdBackAtPercent). */
export const DEFAULT_HOLD_BACK_PERCENT = 80;

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
  /**
   * Share of the week left (0..1): the tighter of the account's week and the
   * model's own week; null when neither was measured.
   */
  weekLeft: number | null;
  /** Its week is nearly spent, so it goes after every account whose week is not. */
  heldBack: boolean;
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
 *
 * `holdBackAtPercent` is how full a week holds the account back; null for an
 * order that does not hold accounts back (only the smart order does).
 */
export function standingOf(
  entry: RunwayWindows | undefined,
  now: number,
  model?: string | null,
  holdBackAtPercent: number | null = DEFAULT_HOLD_BACK_PERCENT,
): Standing {
  const cost = windowCostOf(entry);
  const candidates: Array<{ binding: Standing['binding']; windows: number }> = [];

  const fiveHour = used(entry?.fiveHour, entry?.fiveHourReset, now);
  candidates.push({ binding: '5-hour', windows: fiveHour === null ? 1 : 1 - fiveHour });

  const weekly = used(entry?.sevenDay, entry?.sevenDayReset, now);
  const weeklyWindowsLeft = weekly === null ? null : (1 - weekly) / cost;
  if (weeklyWindowsLeft !== null) candidates.push({ binding: 'weekly', windows: weeklyWindowsLeft });
  const weekShares: number[] = weekly === null ? [] : [1 - weekly];

  if (model) {
    const key = normalizeModel(model);
    const own = (entry?.models ?? []).find((m) => normalizeModel(m.name) === key);
    const modelUsed = own ? used(own.utilization, own.resetsAt, now) : null;
    if (modelUsed !== null) {
      candidates.push({ binding: 'model', windows: (1 - modelUsed) / cost });
      weekShares.push(1 - modelUsed);
    }
  }
  const weekLeft = weekShares.length > 0 ? Math.min(...weekShares) : null;
  // Compared in whole points, as the usage arrives and the screen shows it, so
  // a week reading 80% is held back at 80 rather than escaping on a rounding.
  const heldBack =
    holdBackAtPercent !== null && weekLeft !== null && Math.round((1 - weekLeft) * 100) >= holdBackAtPercent;

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
    weekLeft,
    heldBack,
  };
}

/**
 * One number to sort by, higher first: worth moving at all, then not held
 * back, then runway in tenths of a window, then urgency. Each step outweighs
 * everything after it (runway adds at most 10, urgency under 1). Ties after
 * that fall to the priority order (the comparator), so the order is always
 * fully determined.
 *
 * Worth moving outranks held back: a nearly spent week with a fresh 5-hour
 * window still beats a healthy week whose 5-hour window has minutes left.
 *
 * Urgency only counts where there is room to use it: an account with no
 * runway at all is spent for now, and must not rank above one with a sliver.
 */
export function pickScore(standing: Standing): number {
  const urgency = standing.runway > 0 ? Math.min(1, standing.urgency) * 0.99 : 0;
  return (
    (standing.worthMoving ? 100 : 0) +
    (standing.heldBack ? 0 : 50) +
    Math.round(standing.runway * 10) +
    urgency
  );
}

/** Where a measurement of the window cost started: one reading, as it was. */
export interface CostAnchor {
  fiveHour: number;
  sevenDay: number;
  fiveHourReset: number | null;
  sevenDayReset: number | null;
}

/**
 * How far the 5-hour window must move before a sample is taken. Usage comes in
 * whole percents, so over a few points the weekly change is 0 or 1 point and
 * the sample is noise; across a fifth of a window it is a measurement.
 */
const MIN_SAMPLE_SPAN = 0.2;

/**
 * Learn what one full 5-hour window costs the week on an account.
 *
 * A measurement runs from an ANCHOR reading to the first later reading in the
 * same 5-hour and weekly windows whose 5-hour share has moved by at least
 * MIN_SAMPLE_SPAN; the sample is the weekly share used over the 5-hour share
 * used. Measuring from one reading to the next instead, a few minutes apart,
 * only ever sees a point or two of either, and one such sample (a week that
 * did not move) read as nearly free and hid the week from the picker.
 *
 * Folded into a running average that starts from the default, so the first
 * sample moves it part of the way rather than replacing it. A reset of either
 * window starts a new anchor. Returns the cost and the anchor to keep.
 *
 * A model's own weekly window (Fable) is scaled by this same cost: readings are
 * per account, not per model, so a share of the week cannot be attributed to
 * one model when several ran. Accounts that ran mostly Fable show its window
 * moving within about a tenth of the week, close enough to use the same cost.
 */
export function learnWindowCost(
  previous: (RunwayWindows & { costAnchor?: CostAnchor | null }) | undefined,
  next: RunwayWindows,
): { windowCost: number | null; costAnchor: CostAnchor | null } {
  const known = typeof previous?.windowCost === 'number' ? previous.windowCost : null;
  const here: CostAnchor | null =
    typeof next.fiveHour === 'number' && typeof next.sevenDay === 'number'
      ? {
          fiveHour: next.fiveHour,
          sevenDay: next.sevenDay,
          fiveHourReset: next.fiveHourReset ?? null,
          sevenDayReset: next.sevenDayReset ?? null,
        }
      : null;
  const anchor = previous?.costAnchor ?? null;
  const same = (a: number | null | undefined, b: number | null | undefined): boolean =>
    typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 60_000;
  if (!anchor || !here) return { windowCost: known, costAnchor: here ?? anchor };
  if (!same(anchor.fiveHourReset, here.fiveHourReset) || !same(anchor.sevenDayReset, here.sevenDayReset)) {
    return { windowCost: known, costAnchor: here }; // a window reset: start over
  }
  const fiveHourUsed = here.fiveHour - anchor.fiveHour;
  const weeklyUsed = here.sevenDay - anchor.sevenDay;
  if (fiveHourUsed < MIN_SAMPLE_SPAN - 1e-9) return { windowCost: known, costAnchor: anchor }; // keep measuring
  if (weeklyUsed < 0) return { windowCost: known, costAnchor: here };
  const sample = Math.min(1, Math.max(0.01, weeklyUsed / fiveHourUsed));
  return { windowCost: (known ?? DEFAULT_WINDOW_COST) * 0.7 + sample * 0.3, costAnchor: here };
}
