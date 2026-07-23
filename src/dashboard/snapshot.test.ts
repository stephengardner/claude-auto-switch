import { describe, it, expect } from 'vitest';
import { toSnapshot, type SnapshotInput } from './snapshot.js';

const NOW = 1_000_000_000;

function input(over: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    accounts: [
      { name: 'b', enabled: true, priority: 1, email: 'b@x', plan: 'pro' },
      { name: 'a', enabled: true, priority: 0, email: 'a@x', plan: 'max' },
    ],
    loggedIn: new Set(['a']),
    cappedUntil: new Map(),
    active: 'a',
    events: [],
    now: NOW,
    refreshMs: 2000,
    ...over,
  };
}

describe('toSnapshot', () => {
  it('orders accounts by priority then name', () => {
    const s = toSnapshot(input());
    expect(s.accounts.map((a) => a.name)).toEqual(['a', 'b']);
  });

  it('marks logged-in and active correctly', () => {
    const s = toSnapshot(input());
    const a = s.accounts.find((x) => x.name === 'a')!;
    const b = s.accounts.find((x) => x.name === 'b')!;
    expect(a.loggedIn).toBe(true);
    expect(a.active).toBe(true);
    expect(b.loggedIn).toBe(false);
    expect(b.active).toBe(false);
  });

  it('carries capped-until only for capped accounts', () => {
    const s = toSnapshot(input({ cappedUntil: new Map([['b', NOW + 60000]]) }));
    expect(s.accounts.find((x) => x.name === 'b')!.cappedUntil).toBe(NOW + 60000);
    expect(s.accounts.find((x) => x.name === 'a')!.cappedUntil).toBeUndefined();
  });

  it('prefers live email/plan over the cached registry values', () => {
    const s = toSnapshot(
      input({
        liveEmail: new Map([['a', 'live@x']]),
        livePlan: new Map([['a', 'team']]),
      }),
    );
    const a = s.accounts.find((x) => x.name === 'a')!;
    expect(a.email).toBe('live@x');
    expect(a.plan).toBe('team');
  });

  it('passes through events, now, and refreshMs', () => {
    const s = toSnapshot(input({ events: ['swap a->b'] }));
    expect(s.events).toEqual(['swap a->b']);
    expect(s.now).toBe(NOW);
    expect(s.refreshMs).toBe(2000);
  });
});
