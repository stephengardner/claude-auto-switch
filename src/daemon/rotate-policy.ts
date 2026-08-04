import type { UsageSnapshot } from './usage.js';
import { windowIsOpen } from '../usage/window-open.js';

export interface AccountUsage {
  name: string;
  /** null when the account has no usage cache yet (never used); treated as full headroom. */
  usage: UsageSnapshot | null;
}

export interface RotateDecision {
  shouldRotate: boolean;
  reason: string;
  target?: string;
}

export interface RotateInput {
  active: string;
  accounts: AccountUsage[];
  /** Percent at which an account is considered capped (e.g. 95 for proactive rotation). */
  threshold: number;
  /** Judged against this instant, so a window that has reset is not a cap. */
  now?: number;
}

/**
 * An account is capped if it is rate-limited now, or at/over the threshold in a
 * window that is STILL OPEN. A window past its reset records a limit that has
 * lifted, and counting it keeps an account benched long after it recovered.
 */
function isCapped(u: UsageSnapshot | null, threshold: number, now: number): boolean {
  if (!u) return false;
  if (u.retryAfter !== null && u.retryAfter > 0) return true;
  if (u.fiveHourPct !== null && u.fiveHourPct >= threshold && windowIsOpen(u.fiveHourResetsAt, now)) {
    return true;
  }
  if (u.sevenDayPct !== null && u.sevenDayPct >= threshold && windowIsOpen(u.sevenDayResetsAt, now)) {
    return true;
  }
  return false;
}

/** Higher is better. No usage data means a fresh account with full headroom. */
function headroom(u: UsageSnapshot | null, now: number): number {
  if (!u) return 100;
  // A window that has reset contributes nothing: its number is about a limit
  // that is over, so counting it would rank a recovered account last.
  const fiveHour = windowIsOpen(u.fiveHourResetsAt, now) ? (u.fiveHourPct ?? 0) : 0;
  const sevenDay = windowIsOpen(u.sevenDayResetsAt, now) ? (u.sevenDayPct ?? 0) : 0;
  return 100 - Math.max(fiveHour, sevenDay);
}

/**
 * Decide whether to rotate off the active account and to which account. Rotates
 * only when the active account is capped and a non-capped account exists; picks
 * the candidate with the most headroom.
 */
export function decideRotation(input: RotateInput): RotateDecision {
  const { active, accounts, threshold } = input;
  const now = input.now ?? Date.now();
  const activeAccount = accounts.find((a) => a.name === active);

  if (!activeAccount || !isCapped(activeAccount.usage, threshold, now)) {
    return { shouldRotate: false, reason: 'active account has headroom' };
  }

  const target = accounts
    .filter((a) => a.name !== active && !isCapped(a.usage, threshold, now))
    .sort((a, b) => headroom(b.usage, now) - headroom(a.usage, now))[0];

  if (!target) {
    return { shouldRotate: false, reason: 'all accounts are capped; waiting for a reset' };
  }
  return {
    shouldRotate: true,
    target: target.name,
    reason: `active account "${active}" is capped; switching to "${target.name}"`,
  };
}
