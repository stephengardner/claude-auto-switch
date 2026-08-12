import { describe, it, expect, vi } from 'vitest';
import { refresherTick, startUsageRefresher, type UsageRefresherDeps } from './usage-refresher.js';

function deps(overrides: Partial<UsageRefresherDeps> = {}) {
  const refreshed: number[] = [];
  const released: number[] = [];
  const outcomes: string[] = [];
  const d: UsageRefresherDeps = {
    refresh: () => {
      refreshed.push(Date.now());
      return Promise.resolve();
    },
    snapshotAgeMs: () => Number.POSITIVE_INFINITY,
    tryLock: () => ({ held: true, release: () => released.push(Date.now()) }),
    onOutcome: (outcome) => outcomes.push(outcome),
    ...overrides,
  };
  return { d, refreshed, released, outcomes };
}

describe('one refresh cycle', () => {
  it('refreshes when the snapshot is stale, and releases the lock after', async () => {
    const { d, refreshed, released } = deps();
    expect(await refresherTick(d, 300_000)).toBe('refreshed');
    expect(refreshed).toHaveLength(1);
    expect(released).toHaveLength(1);
  });

  it('skips when the snapshot is younger than half the interval', async () => {
    // This is what keeps N concurrent sessions from multiplying the probes:
    // whoever refreshed last covered everyone.
    const { d, refreshed } = deps({ snapshotAgeMs: () => 60_000 });
    expect(await refresherTick(d, 300_000)).toBe('fresh-enough');
    expect(refreshed).toHaveLength(0);
  });

  it('steps aside when another session holds the refresh lock', async () => {
    const { d, refreshed } = deps({ tryLock: () => ({ held: false, release: () => {} }) });
    expect(await refresherTick(d, 300_000)).toBe('busy');
    expect(refreshed).toHaveLength(0);
  });

  it('reports an error without throwing, and still releases the lock', async () => {
    // A failed refresh must never take the session down with it.
    const { released, outcomes } = deps();
    const failing = deps({
      refresh: () => Promise.reject(new Error('endpoint down')),
      tryLock: () => ({ held: true, release: () => released.push(Date.now()) }),
      onOutcome: (o, detail) => outcomes.push(`${o}:${detail.error ?? ''}`),
    });
    expect(await refresherTick(failing.d, 300_000)).toBe('error');
    expect(released).toHaveLength(1);
    expect(outcomes).toEqual(['error:endpoint down']);
  });
});

describe('the session-long runner', () => {
  it('ticks immediately, because the usual problem is a snapshot nobody touched', () => {
    vi.useFakeTimers();
    try {
      const { d, refreshed } = deps();
      const runner = startUsageRefresher(d, 300_000);
      expect(refreshed).toHaveLength(1);
      runner.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps ticking on the interval until stopped', async () => {
    vi.useFakeTimers();
    try {
      const { d, refreshed } = deps();
      const runner = startUsageRefresher(d, 300_000);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(refreshed).toHaveLength(2);
      runner.stop();
      await vi.advanceTimersByTimeAsync(900_000);
      expect(refreshed).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never overlaps a slow refresh with the next tick', async () => {
    vi.useFakeTimers();
    try {
      let inFlight = 0;
      let peak = 0;
      const slow = deps({
        refresh: () =>
          new Promise((resolve) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            setTimeout(() => {
              inFlight -= 1;
              resolve(undefined);
            }, 700_000); // longer than two intervals
          }),
      });
      const runner = startUsageRefresher(slow.d, 300_000);
      await vi.advanceTimersByTimeAsync(650_000);
      expect(peak).toBe(1);
      runner.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
