import { describe, it, expect } from 'vitest';
import { bindingUtilization, headroom, decideProactiveSwitch, type UsageLike } from './headroom.js';

const usage = (fiveHour: number | null, sevenDay: number | null, models?: Array<{ name: string; utilization: number }>): UsageLike => ({
  fiveHour,
  sevenDay,
  ...(models ? { models } : {}),
});

describe('bindingUtilization', () => {
  it('is the worst window, including per-model ones', () => {
    // The account looks fine on 5h/weekly but Fable's weekly window is nearly out.
    expect(bindingUtilization(usage(0.16, 0.43, [{ name: 'Fable', utilization: 0.78 }]))).toBeCloseTo(0.78);
  });

  it('narrows to one model when asked', () => {
    const u = usage(0.9, 0.2, [{ name: 'Fable', utilization: 0.3 }, { name: 'Opus', utilization: 0.99 }]);
    // Only Fable's window plus the account-wide ones count.
    expect(bindingUtilization(u, 'Fable')).toBeCloseTo(0.9);
  });

  it('is null when nothing is known', () => {
    expect(bindingUtilization(usage(null, null))).toBeNull();
    expect(bindingUtilization(undefined)).toBeNull();
  });
});

describe('headroom', () => {
  it('is the room left on the binding window', () => {
    expect(headroom(usage(0.25, 0.1))).toBeCloseTo(0.75);
    expect(headroom(usage(1.2, 0.1))).toBe(0); // never negative
    expect(headroom(undefined)).toBeNull();
  });
});

describe('decideProactiveSwitch', () => {
  const candidates = [
    { name: 'a', enabled: true, loggedIn: true },
    { name: 'b', enabled: true, loggedIn: true },
    { name: 'c', enabled: true, loggedIn: true },
  ];

  it('does nothing while the current account is under the threshold', () => {
    const d = decideProactiveSwitch({
      current: 'a',
      candidates,
      usage: new Map([['a', usage(0.5, 0.1)], ['b', usage(0.01, 0.01)]]),
      thresholdPercent: 90,
    });
    expect(d.switchTo).toBeNull();
    expect(d.reason).toContain('under threshold');
  });

  it('moves to the roomiest account once the current one is nearly out', () => {
    const d = decideProactiveSwitch({
      current: 'a',
      candidates,
      usage: new Map([
        ['a', usage(0.95, 0.1)],
        ['b', usage(0.5, 0.5)],
        ['c', usage(0.02, 0.03)], // roomiest
      ]),
      thresholdPercent: 90,
    });
    expect(d.switchTo).toBe('c');
  });

  it('fires on a per-model window even when the account-wide numbers look healthy', () => {
    const d = decideProactiveSwitch({
      current: 'a',
      candidates,
      usage: new Map([
        ['a', usage(0.16, 0.43, [{ name: 'Fable', utilization: 0.95 }])],
        ['b', usage(0.05, 0.05, [{ name: 'Fable', utilization: 0.03 }])],
      ]),
      thresholdPercent: 90,
    });
    expect(d.switchTo).toBe('b');
  });

  it('never switches on unknown usage (current or target)', () => {
    expect(
      decideProactiveSwitch({
        current: 'a',
        candidates,
        usage: new Map([['b', usage(0.01, 0.01)]]), // current unknown
        thresholdPercent: 90,
      }).switchTo,
    ).toBeNull();

    expect(
      decideProactiveSwitch({
        current: 'a',
        candidates,
        usage: new Map([['a', usage(0.99, 0.1)]]), // targets unknown
        thresholdPercent: 90,
      }).switchTo,
    ).toBeNull();
  });

  it('will not flap to an account that is barely better, or itself at the threshold', () => {
    const d = decideProactiveSwitch({
      current: 'a',
      candidates,
      usage: new Map([
        ['a', usage(0.92, 0.1)],
        ['b', usage(0.93, 0.1)], // also over the threshold
        ['c', usage(0.9, 0.1)], // not meaningfully roomier
      ]),
      thresholdPercent: 90,
      hysteresisPercent: 10,
    });
    expect(d.switchTo).toBeNull();
    expect(d.reason).toContain('no roomier account');
  });

  it('skips disabled, logged-out, capped, and the current account itself', () => {
    const d = decideProactiveSwitch({
      current: 'a',
      candidates: [
        { name: 'a', enabled: true, loggedIn: true },
        { name: 'b', enabled: false, loggedIn: true },
        { name: 'c', enabled: true, loggedIn: false },
        { name: 'd', enabled: true, loggedIn: true, capped: true },
      ],
      usage: new Map([
        ['a', usage(0.99, 0.1)],
        ['b', usage(0, 0)],
        ['c', usage(0, 0)],
        ['d', usage(0, 0)],
      ]),
      thresholdPercent: 90,
    });
    expect(d.switchTo).toBeNull();
  });
});
