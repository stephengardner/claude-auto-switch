import { describe, it, expect } from 'vitest';
import { decideRotation, type AccountUsage } from './rotate-policy.js';
import type { UsageSnapshot } from './usage.js';

function usage(fiveHour: number, opts: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    fiveHourPct: fiveHour,
    sevenDayPct: opts.sevenDayPct ?? 0,
    fiveHourResetsAt: null,
    sevenDayResetsAt: null,
    retryAfter: opts.retryAfter ?? null,
    fetchedAt: null,
    stale: false,
  };
}

function acct(name: string, u: UsageSnapshot | null): AccountUsage {
  return { name, usage: u };
}

describe('decideRotation', () => {
  it('does not rotate when the active account has headroom', () => {
    const d = decideRotation({
      active: 'a',
      threshold: 95,
      accounts: [acct('a', usage(40)), acct('b', usage(10))],
    });
    expect(d.shouldRotate).toBe(false);
  });

  it('rotates to the account with the most headroom when active is over threshold', () => {
    const d = decideRotation({
      active: 'a',
      threshold: 95,
      accounts: [acct('a', usage(96)), acct('b', usage(60)), acct('c', usage(20))],
    });
    expect(d.shouldRotate).toBe(true);
    expect(d.target).toBe('c');
  });

  it('treats a fresh (no-cache) account as full headroom', () => {
    const d = decideRotation({
      active: 'a',
      threshold: 95,
      accounts: [acct('a', usage(99)), acct('b', usage(50)), acct('c', null)],
    });
    expect(d.target).toBe('c');
  });

  it('rotates when the active account is actively rate-limited (retry_after set)', () => {
    const d = decideRotation({
      active: 'a',
      threshold: 95,
      accounts: [acct('a', usage(80, { retryAfter: 1800 })), acct('b', usage(10))],
    });
    expect(d.shouldRotate).toBe(true);
    expect(d.target).toBe('b');
  });

  it('does not rotate when every other account is also capped', () => {
    const d = decideRotation({
      active: 'a',
      threshold: 95,
      accounts: [acct('a', usage(97)), acct('b', usage(96))],
    });
    expect(d.shouldRotate).toBe(false);
    expect(d.reason).toContain('all accounts');
  });
});
