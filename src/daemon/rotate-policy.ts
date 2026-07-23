import type { UsageSnapshot } from './usage.js';

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
}

/** An account is capped if it is rate-limited now, or at/over the threshold in either window. */
function isCapped(u: UsageSnapshot | null, threshold: number): boolean {
  if (!u) return false;
  if (u.retryAfter !== null && u.retryAfter > 0) return true;
  if (u.fiveHourPct !== null && u.fiveHourPct >= threshold) return true;
  if (u.sevenDayPct !== null && u.sevenDayPct >= threshold) return true;
  return false;
}

/** Higher is better. No usage data means a fresh account with full headroom. */
function headroom(u: UsageSnapshot | null): number {
  if (!u) return 100;
  return 100 - Math.max(u.fiveHourPct ?? 0, u.sevenDayPct ?? 0);
}

/**
 * Decide whether to rotate off the active account and to which account. Rotates
 * only when the active account is capped and a non-capped account exists; picks
 * the candidate with the most headroom.
 */
export function decideRotation(input: RotateInput): RotateDecision {
  const { active, accounts, threshold } = input;
  const activeAccount = accounts.find((a) => a.name === active);

  if (!activeAccount || !isCapped(activeAccount.usage, threshold)) {
    return { shouldRotate: false, reason: 'active account has headroom' };
  }

  const target = accounts
    .filter((a) => a.name !== active && !isCapped(a.usage, threshold))
    .sort((a, b) => headroom(b.usage) - headroom(a.usage))[0];

  if (!target) {
    return { shouldRotate: false, reason: 'all accounts are capped; waiting for a reset' };
  }
  return {
    shouldRotate: true,
    target: target.name,
    reason: `active account "${active}" is capped; switching to "${target.name}"`,
  };
}
