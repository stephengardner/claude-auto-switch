import { describe, it, expect } from 'vitest';
import { usableCapacity, remainingRoom } from './usable-capacity.js';
import type { UsageEntry } from './usage-store.js';

const NOW = Date.UTC(2026, 7, 4, 12, 0, 0); // 2026-08-04T12:00:00Z
const HOUR = 3_600_000;

function entry(over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    fiveHour: 0,
    sevenDay: 0,
    fiveHourReset: null,
    sevenDayReset: null,
    at: NOW - HOUR,
    ...over,
  };
}

describe('usableCapacity', () => {
  it('IGNORES a spent model whose window has already reset', () => {
    // The real case this was written for: a cached entry said Fable was fully
    // spent with a reset time that had passed, so a session starting on Fable
    // would be moved off a model that was available again.
    const capacity = usableCapacity(
      entry({ models: [{ name: 'Fable', utilization: 1, resetsAt: NOW - HOUR }] }),
      NOW,
    );
    // Left out entirely, which downstream reads as "unmeasured", meaning room.
    expect(capacity.models).toEqual({});
  });

  it('keeps a spent model whose window is still closed', () => {
    const capacity = usableCapacity(
      entry({ models: [{ name: 'Fable', utilization: 1, resetsAt: NOW + HOUR }] }),
      NOW,
    );
    expect(capacity.models).toEqual({ Fable: 1 });
  });

  it('keeps a number with no reset time, having no evidence it lifted', () => {
    const capacity = usableCapacity(
      entry({ models: [{ name: 'Fable', utilization: 1 }] }),
      NOW,
    );
    expect(capacity.models).toEqual({ Fable: 1 });
  });

  it('is out account-wide only while the window is still closed', () => {
    expect(usableCapacity(entry({ fiveHour: 1, fiveHourReset: NOW + HOUR }), NOW).accountWideOut).toBe(
      true,
    );
    expect(usableCapacity(entry({ fiveHour: 1, fiveHourReset: NOW - HOUR }), NOW).accountWideOut).toBe(
      false,
    );
    expect(usableCapacity(entry({ sevenDay: 1, sevenDayReset: NOW + HOUR }), NOW).accountWideOut).toBe(
      true,
    );
  });

  it('is not out when a window is merely busy', () => {
    expect(usableCapacity(entry({ fiveHour: 0.99 }), NOW).accountWideOut).toBe(false);
  });

  it('reads a missing entry as nothing known, not as nothing available', () => {
    expect(usableCapacity(undefined, NOW)).toEqual({ models: {}, accountWideOut: false });
  });

  it('keeps every model that is still current, with its number', () => {
    const capacity = usableCapacity(
      entry({
        models: [
          { name: 'Fable', utilization: 1, resetsAt: NOW - 1 }, // expired by a millisecond
          { name: 'Opus', utilization: 0.3, resetsAt: NOW + HOUR },
          { name: 'Sonnet', utilization: 0, resetsAt: null },
        ],
      }),
      NOW,
    );
    expect(capacity.models).toEqual({ Opus: 0.3, Sonnet: 0 });
  });
});

describe('remainingRoom (how used an account is overall)', () => {
  it('reports 1 (least-used) when there is no usage data', () => {
    expect(remainingRoom(undefined, NOW)).toBe(1);
    expect(remainingRoom(entry({ fiveHour: null, sevenDay: null }), NOW)).toBe(1);
  });

  it('is 1 minus the TIGHTER of the two open windows', () => {
    // 5-hour 30% used, weekly 70% used -> weekly binds -> 30% room.
    const room = remainingRoom(
      entry({ fiveHour: 0.3, sevenDay: 0.7, fiveHourReset: NOW + HOUR, sevenDayReset: NOW + HOUR }),
      NOW,
    );
    expect(room).toBeCloseTo(0.3, 5);
  });

  it('treats a window past its reset as free (does not count it)', () => {
    // 5-hour reads 0.9 but its window already reset (in the past) -> 0 used there;
    // weekly is open at 0.2 -> room 0.8.
    const room = remainingRoom(
      entry({ fiveHour: 0.9, fiveHourReset: NOW - HOUR, sevenDay: 0.2, sevenDayReset: NOW + HOUR }),
      NOW,
    );
    expect(room).toBeCloseTo(0.8, 5);
  });

  it('is 0 for a fully spent account and never negative', () => {
    expect(remainingRoom(entry({ fiveHour: 1, fiveHourReset: NOW + HOUR }), NOW)).toBe(0);
    expect(remainingRoom(entry({ sevenDay: 1.5, sevenDayReset: NOW + HOUR }), NOW)).toBe(0);
  });

  it('orders a roomier account above a busier one', () => {
    const roomy = remainingRoom(entry({ sevenDay: 0.1, sevenDayReset: NOW + HOUR }), NOW);
    const busy = remainingRoom(entry({ sevenDay: 0.85, sevenDayReset: NOW + HOUR }), NOW);
    expect(roomy).toBeGreaterThan(busy);
  });
});
