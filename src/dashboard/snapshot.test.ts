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

  it('carries the next move in both wordings, and neither when there is none', () => {
    const whenOut = { account: 'b', words: 'b (a full 5-hour window)' };
    const s = toSnapshot(input({ nextUp: 'over on b, on opus', whenOut }));
    expect(s.nextUp).toBe('over on b, on opus');
    expect(s.whenOut).toEqual(whenOut);
    expect('whenOut' in toSnapshot(input())).toBe(false);
    expect('whenOut' in toSnapshot(input({ whenOut: null }))).toBe(false);
  });

  it('passes through events, now, and refreshMs', () => {
    const s = toSnapshot(input({ events: ['swap a->b'] }));
    expect(s.events).toEqual(['swap a->b']);
    expect(s.now).toBe(NOW);
    expect(s.refreshMs).toBe(2000);
  });
});

describe('tags in the snapshot', () => {
  it('carries each account tags, and nothing for one without', () => {
    const s = toSnapshot(
      input({
        accounts: [
          { name: 'a', enabled: true, priority: 0, tags: ['bot', 'pat'] },
          { name: 'b', enabled: true, priority: 1 },
        ],
      }),
    );
    expect(s.accounts.find((a) => a.name === 'a')?.tags).toEqual(['bot', 'pat']);
    expect('tags' in (s.accounts.find((a) => a.name === 'b') ?? {})).toBe(false);
  });
});

describe('what the snapshot carries for `ccx state`', () => {
  const standing = {
    runway: 1,
    binding: 'none' as const,
    weeklyWindowsLeft: null,
    weekLeft: null,
    heldBack: false,
    worthMoving: true,
  };

  it("carries each account's folder, login check and standing, and nothing it was not given", () => {
    const s = toSnapshot(
      input({
        accounts: [
          { name: 'a', enabled: true, priority: 0, dir: '/p/a' },
          { name: 'b', enabled: true, priority: 1 },
        ],
        loginCheckedAt: new Map([['a', NOW - 5]]),
        standings: new Map([['a', standing]]),
      }),
    );
    const a = s.accounts.find((x) => x.name === 'a');
    const b = s.accounts.find((x) => x.name === 'b') ?? {};
    expect(a?.configDir).toBe('/p/a');
    expect(a?.loginCheckedAt).toBe(NOW - 5);
    expect(a?.standing).toEqual(standing);
    for (const key of ['configDir', 'loginCheckedAt', 'standing']) expect(key in b).toBe(false);
  });

  it('carries the settings as values, and none when it was given none', () => {
    const rotation = {
      accountOrder: 'priority' as const,
      modelPreference: ['opus'],
      modelStrategy: 'account-first' as const,
      preferSameModel: false,
      holdBackAtPercent: null,
      proactivePercent: 70,
    };
    expect(toSnapshot(input({ rotation })).rotation).toEqual(rotation);
    expect('rotation' in toSnapshot(input())).toBe(false);
  });
});
