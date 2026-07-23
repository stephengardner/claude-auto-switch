import { describe, it, expect } from 'vitest';
import { tick, type DaemonDeps } from './daemon.js';
import type { UsageSnapshot } from './usage.js';

function usage(pct: number, retryAfter: number | null = null): UsageSnapshot {
  return {
    fiveHourPct: pct,
    sevenDayPct: 0,
    fiveHourResetsAt: null,
    sevenDayResetsAt: null,
    retryAfter,
    fetchedAt: null,
    stale: false,
  };
}

function harness(usageByDir: Record<string, UsageSnapshot | null>) {
  let active = 'a';
  const flips: string[] = [];
  const logs: string[] = [];
  const deps: DaemonDeps = {
    profiles: () => [
      { name: 'a', dir: '/a' },
      { name: 'b', dir: '/b' },
    ],
    getActive: () => active,
    setActive: (n) => {
      active = n;
    },
    readUsage: (dir) => usageByDir[dir] ?? null,
    flip: (t) => flips.push(t),
    threshold: 95,
    log: (m) => logs.push(m),
    now: () => 0,
  };
  return { deps, flips, logs, getActive: () => active };
}

describe('daemon tick', () => {
  it('rotates and persists the new active when the active account is capped', () => {
    const h = harness({ '/a': usage(97), '/b': usage(10) });
    const r = tick(h.deps);
    expect(r.rotated).toBe(true);
    expect(h.getActive()).toBe('b');
    expect(h.flips).toEqual(['/b']);
    expect(h.logs[0]).toContain('rotated a -> b');
  });

  it('does nothing when the active account has headroom', () => {
    const h = harness({ '/a': usage(20), '/b': usage(10) });
    expect(tick(h.deps).rotated).toBe(false);
    expect(h.flips).toEqual([]);
    expect(h.getActive()).toBe('a');
  });

  it('rotates on an active retry_after even below threshold', () => {
    const h = harness({ '/a': usage(50, 1800), '/b': usage(80) });
    expect(tick(h.deps).rotated).toBe(true);
    expect(h.getActive()).toBe('b');
  });

  it('stays put when every account is capped', () => {
    const h = harness({ '/a': usage(99), '/b': usage(98) });
    expect(tick(h.deps).rotated).toBe(false);
    expect(h.flips).toEqual([]);
  });
});
