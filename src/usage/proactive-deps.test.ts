import { describe, it, expect } from 'vitest';
import { toUsageLike } from './proactive-deps.js';
import { bindingUtilization } from './headroom.js';
import type { UsageEntry } from './usage-store.js';

const T0 = Date.UTC(2026, 7, 4, 12, 0, 0);
const AN_HOUR = 3_600_000;

function entry(over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    fiveHour: 0,
    sevenDay: 0,
    fiveHourReset: null,
    sevenDayReset: null,
    at: T0,
    ...over,
  };
}

describe('toUsageLike', () => {
  it('carries the ACCOUNT-WIDE reset times through', () => {
    // Without these the policy cannot tell a live cap from one that has lifted,
    // and the policy's own tests would not notice because they build their
    // input by hand.
    const like = toUsageLike(entry({ fiveHour: 1, fiveHourReset: T0 + AN_HOUR, sevenDayReset: T0 }));
    expect(like.fiveHourReset).toBe(T0 + AN_HOUR);
    expect(like.sevenDayReset).toBe(T0);
  });

  it('carries the PER-MODEL reset times through', () => {
    const like = toUsageLike(
      entry({ models: [{ name: 'Fable', utilization: 1, resetsAt: T0 - AN_HOUR }] }),
    );
    expect(like.models?.[0]?.resetsAt).toBe(T0 - AN_HOUR);
  });

  it('feeds the policy well enough to ignore a window that has reset', () => {
    // The end-to-end point of the mapping, asserted through the real consumer
    // rather than by comparing shapes: a spent Fable whose window is over must
    // not be the binding number.
    const like = toUsageLike(
      entry({
        fiveHour: 0.07,
        models: [{ name: 'Fable', utilization: 1, resetsAt: T0 - AN_HOUR }],
      }),
    );
    expect(bindingUtilization(like, undefined, T0)).toBe(0.07);
  });

  it('still binds on a window that is genuinely open', () => {
    const like = toUsageLike(
      entry({
        fiveHour: 0.07,
        models: [{ name: 'Fable', utilization: 1, resetsAt: T0 + AN_HOUR }],
      }),
    );
    expect(bindingUtilization(like, undefined, T0)).toBe(1);
  });

  it('omits models entirely when the entry has none', () => {
    expect(toUsageLike(entry()).models).toBeUndefined();
  });
});
