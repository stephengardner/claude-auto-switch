import { describe, it, expect } from 'vitest';
import { select, type SelectableAccount } from './selector.js';

function acct(name: string, priority: number, enabled = true): SelectableAccount {
  return { name, priority, enabled };
}

describe('select', () => {
  it('returns the lowest-priority eligible account', () => {
    const r = select({
      accounts: [acct('a', 1), acct('b', 0)],
      loggedIn: new Set(['a', 'b']),
      capped: new Set(),
    });
    expect(r.ok && r.account.name).toBe('b');
  });

  it('breaks priority ties by name', () => {
    const r = select({
      accounts: [acct('beta', 0), acct('alpha', 0)],
      loggedIn: new Set(['alpha', 'beta']),
      capped: new Set(),
    });
    expect(r.ok && r.account.name).toBe('alpha');
  });

  it('honors a pinned account when it is eligible', () => {
    const r = select({
      accounts: [acct('a', 0), acct('b', 1)],
      loggedIn: new Set(['a', 'b']),
      capped: new Set(),
      pinned: 'b',
    });
    expect(r.ok && r.account.name).toBe('b');
  });

  it('falls back to the best eligible account when the pinned one is capped', () => {
    const r = select({
      accounts: [acct('a', 0), acct('b', 1)],
      loggedIn: new Set(['a', 'b']),
      capped: new Set(['a']),
      pinned: 'a',
    });
    expect(r.ok && r.account.name).toBe('b');
  });

  it('skips capped, logged-out, and disabled accounts', () => {
    const r = select({
      accounts: [acct('capped', 0), acct('out', 1), acct('off', 2, false), acct('good', 3)],
      loggedIn: new Set(['capped', 'off', 'good']),
      capped: new Set(['capped']),
    });
    expect(r.ok && r.account.name).toBe('good');
  });

  it('reports when no accounts are registered', () => {
    const r = select({ accounts: [], loggedIn: new Set(), capped: new Set() });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('no accounts');
  });

  it('reports when nothing is logged in', () => {
    const r = select({ accounts: [acct('a', 0)], loggedIn: new Set(), capped: new Set() });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('logged in');
  });

  it('reports when all logged-in accounts are capped', () => {
    const r = select({
      accounts: [acct('a', 0)],
      loggedIn: new Set(['a']),
      capped: new Set(['a']),
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('capped');
  });
});
