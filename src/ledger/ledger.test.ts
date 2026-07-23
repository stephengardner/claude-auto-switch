import { describe, it, expect } from 'vitest';
import { markCapped, isCapped, cappedNames, clearExpired, clearAccount } from './ledger.js';
import type { Ledger } from './ledger.schema.js';

const empty: Ledger = { caps: [] };
const MIN = 60_000;

describe('ledger', () => {
  it('marks an account capped with a backoff window when no reset time is known', () => {
    const l = markCapped(empty, { account: 'a', now: 1000, backoffMinutes: 5 });
    expect(isCapped(l, 'a', 1000)).toBe(true);
    expect(isCapped(l, 'a', 1000 + 5 * MIN - 1)).toBe(true);
    expect(isCapped(l, 'a', 1000 + 5 * MIN + 1)).toBe(false);
  });

  it('uses an explicit reset time when provided (over the backoff)', () => {
    const l = markCapped(empty, { account: 'a', now: 1000, resetAt: 50_000, backoffMinutes: 999 });
    expect(isCapped(l, 'a', 49_999)).toBe(true);
    expect(isCapped(l, 'a', 50_001)).toBe(false);
  });

  it('replaces a prior cap for the same account', () => {
    let l = markCapped(empty, { account: 'a', now: 0, resetAt: 100 });
    l = markCapped(l, { account: 'a', now: 0, resetAt: 200 });
    expect(l.caps).toHaveLength(1);
    expect(isCapped(l, 'a', 150)).toBe(true);
  });

  it('cappedNames lists only currently-capped accounts', () => {
    let l = markCapped(empty, { account: 'a', now: 0, resetAt: 100 });
    l = markCapped(l, { account: 'b', now: 0, resetAt: 10 });
    expect(cappedNames(l, 50)).toEqual(new Set(['a']));
  });

  it('clearExpired drops caps whose window has passed', () => {
    let l = markCapped(empty, { account: 'a', now: 0, resetAt: 100 });
    l = markCapped(l, { account: 'b', now: 0, resetAt: 10 });
    expect(clearExpired(l, 50).caps.map((c) => c.account)).toEqual(['a']);
  });

  it('clearAccount removes an account cap after a successful run', () => {
    const l = markCapped(empty, { account: 'a', now: 0, resetAt: 100 });
    expect(isCapped(clearAccount(l, 'a'), 'a', 50)).toBe(false);
  });
});
