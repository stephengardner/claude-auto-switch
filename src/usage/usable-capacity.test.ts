import { describe, it, expect } from 'vitest';
import { usableCapacity } from './usable-capacity.js';
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
