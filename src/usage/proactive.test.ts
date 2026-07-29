import { describe, it, expect } from 'vitest';
import { proactiveTick, type ProactiveDeps } from './proactive.js';
import type { UsageLike } from './headroom.js';

const usage = (fiveHour: number, sevenDay: number): UsageLike => ({ fiveHour, sevenDay });

function deps(over: Partial<ProactiveDeps> = {}): { deps: ProactiveDeps; switched: string[] } {
  const switched: string[] = [];
  const base: ProactiveDeps = {
    candidates: () => [
      { name: 'a', enabled: true, loggedIn: true },
      { name: 'b', enabled: true, loggedIn: true },
    ],
    current: () => 'a',
    usage: () =>
      Promise.resolve(
        new Map([
          ['a', usage(0.95, 0.1)],
          ['b', usage(0.02, 0.02)],
        ]),
      ),
    requestSwitch: (name) => switched.push(name),
    thresholdPercent: 90,
    ...over,
  };
  return { deps: base, switched };
}

describe('proactiveTick', () => {
  it('requests a switch when the current account is nearly out', async () => {
    const { deps: d, switched } = deps();
    const r = await proactiveTick(d);
    expect(r.outcome).toBe('switched');
    expect(r.account).toBe('b');
    expect(switched).toEqual(['b']);
  });

  it('does nothing while there is room', async () => {
    const { deps: d, switched } = deps({
      usage: () => Promise.resolve(new Map([['a', usage(0.2, 0.1)], ['b', usage(0.02, 0.02)]])),
    });
    const r = await proactiveTick(d);
    expect(r.outcome).toBe('no-switch');
    expect(switched).toEqual([]);
  });

  it('is off when the threshold is zero', async () => {
    const { deps: d, switched } = deps({ thresholdPercent: 0 });
    expect((await proactiveTick(d)).outcome).toBe('disabled');
    expect(switched).toEqual([]);
  });

  it('honors a cooldown so it cannot switch repeatedly', async () => {
    const { deps: d, switched } = deps({ now: () => 1_000_000 });
    const state = {};
    expect((await proactiveTick(d, state)).outcome).toBe('switched');
    expect((await proactiveTick(d, state)).outcome).toBe('cooldown'); // same clock
    expect(switched).toEqual(['b']);
  });

  it('never throws when usage cannot be read: reports an error and does not switch', async () => {
    const errors: Error[] = [];
    const { deps: d, switched } = deps({
      usage: () => Promise.reject(new Error('offline')),
      onError: (e) => errors.push(e),
    });
    const r = await proactiveTick(d);
    expect(r.outcome).toBe('error');
    expect(switched).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('does nothing without a current account', async () => {
    const { deps: d } = deps({ current: () => null });
    expect((await proactiveTick(d)).outcome).toBe('no-switch');
  });
});
