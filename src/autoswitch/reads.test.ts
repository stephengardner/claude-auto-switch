import { describe, it, expect } from 'vitest';
import {
  bindingLabel,
  countRead,
  failureCounts,
  isRefusal,
  readOutcome,
  readTotals,
  statusOf,
  toReading,
} from './reads.js';

const now = Date.parse('2030-01-15T12:30:00Z');
const HOUR = 3_600_000;

describe('what a usage read came to', () => {
  it('is answered when the endpoint gave numbers', () => {
    const read = readOutcome({ verdict: 'allowed', fiveHour: 0.2, sevenDay: 0.4, fiveHourReset: now + HOUR });
    expect(read).toMatchObject({ ok: true, usage: { fiveHour: 0.2, sevenDay: 0.4, fiveHourReset: now + HOUR, sevenDayReset: null } });
  });

  it('is answered for a seat with no usage window at all', () => {
    expect(readOutcome({ verdict: 'allowed' })).toMatchObject({ ok: true, usage: { fiveHour: null, sevenDay: null } });
  });

  it('is answered when the account is at its limit', () => {
    expect(readOutcome({ verdict: 'limited', fiveHour: 1 })).toMatchObject({ ok: true });
  });

  it('is a failure for anything the endpoint did not answer, with the back-off it asked for', () => {
    expect(readOutcome({ verdict: 'unknown', detail: 'status 429', retryAfterMs: 30_000 })).toEqual({
      ok: false,
      status: 429,
      retryAfterMs: 30_000,
    });
    expect(readOutcome({ verdict: 'unknown', detail: 'fetch failed' })).toEqual({ ok: false, status: 'network' });
  });

  it('says when usage credits carry the account past a full window', () => {
    expect(readOutcome({ verdict: 'limited', fiveHour: 1, creditsCarryPastLimit: true })).toMatchObject({
      ok: true,
      creditsCarry: true,
    });
    expect(readOutcome({ verdict: 'limited', fiveHour: 1 })).not.toHaveProperty('creditsCarry');
  });

  it('carries the per-model weeks', () => {
    const read = readOutcome({ verdict: 'allowed', fiveHour: 0.1, models: [{ name: 'Fable', utilization: 0.9 }] });
    expect(read).toMatchObject({ ok: true, usage: { models: [{ name: 'Fable', utilization: 0.9, resetsAt: null }] } });
  });
});

describe('how a failed read failed', () => {
  it('reads the status back out of the probe\'s text', () => {
    expect(statusOf('status 429')).toBe(429);
    expect(statusOf('status 401')).toBe(401);
    expect(statusOf('This operation was aborted')).toBe('timeout');
    expect(statusOf('fetch failed')).toBe('network');
    expect(statusOf('no oauth token')).toBe('no-token');
    expect(statusOf(undefined)).toBe('unknown');
  });

  it('calls only 401 and 403 a refused login', () => {
    expect(isRefusal(401)).toBe(true);
    expect(isRefusal(403)).toBe(true);
    expect(isRefusal(429)).toBe(false);
    expect(isRefusal('network')).toBe(false);
  });

  it('tells a failure about the account from one about the network', () => {
    expect(failureCounts(401)).toBe(true);
    expect(failureCounts(429)).toBe(true);
    expect(failureCounts(503)).toBe(true);
    expect(failureCounts('network')).toBe(false);
    expect(failureCounts('timeout')).toBe(false);
    expect(failureCounts(404)).toBe(false);
  });
});

describe('an answered read as the decision reads it', () => {
  it('takes the tightest open window, and the tightest account-wide one apart', () => {
    const usage = {
      fiveHour: 0.2,
      sevenDay: 0.5,
      fiveHourReset: now + HOUR,
      sevenDayReset: now + 48 * HOUR,
      models: [{ name: 'Fable', utilization: 0.97, resetsAt: now + HOUR }],
    };
    expect(toReading(usage, now)).toEqual({ used: 0.97, wide: 0.5, at: now });
    expect(bindingLabel(usage, now)).toBe('Fable week 97%');
  });

  it('counts a window past its reset as lifted', () => {
    const usage = { fiveHour: 1, sevenDay: 0.4, fiveHourReset: now - 1, sevenDayReset: now + HOUR };
    expect(toReading(usage, now)).toMatchObject({ used: 0.4 });
    expect(bindingLabel(usage, now)).toBe('week 40%');
  });

  it('reads no window at all as no usage, not as unknown', () => {
    expect(toReading({ fiveHour: null, sevenDay: null }, now)).toEqual({ used: 0, wide: 0, at: now });
    expect(bindingLabel({ fiveHour: null, sevenDay: null }, now)).toBe('no usage window');
  });

  it('marks a reading that usage credits carry, and leaves the others unmarked', () => {
    expect(toReading({ fiveHour: 1, sevenDay: 0.4 }, now, undefined, true)).toEqual({ used: 1, wide: 1, carried: true, at: now });
    expect(toReading({ fiveHour: 1, sevenDay: 0.4 }, now)).toEqual({ used: 1, wide: 1, at: now });
  });

  it('names the 5-hour window when it is the tight one', () => {
    expect(bindingLabel({ fiveHour: 0.9, sevenDay: 0.4 }, now)).toBe('5-hour window 90%');
  });
});

describe('counting reads', () => {
  it('counts by hour, kind and status', () => {
    let counts = countRead({}, 'in-use', 200, now);
    counts = countRead(counts, 'in-use', 200, now + 1000);
    counts = countRead(counts, 'in-use', 429, now + 2000);
    counts = countRead(counts, 'target', 200, now + 3000);
    expect(counts['2030-01-15T12']).toEqual({ 'in-use 200': 2, 'in-use 429': 1, 'target 200': 1 });
  });

  it('drops hours older than two days', () => {
    const old = countRead({}, 'in-use', 200, now - 72 * HOUR);
    const counts = countRead(old, 'in-use', 200, now);
    expect(Object.keys(counts)).toEqual(['2030-01-15T12']);
  });

  it('adds up the last hours asked for', () => {
    let counts = countRead({}, 'in-use', 200, now - 5 * HOUR);
    counts = countRead(counts, 'in-use', 429, now - HOUR);
    counts = countRead(counts, 'in-use', 200, now);
    expect(readTotals(counts, 1, now)).toEqual({ 'in-use 429': 1, 'in-use 200': 1 });
    expect(readTotals(counts, 24, now)).toEqual({ 'in-use 200': 2, 'in-use 429': 1 });
  });
});
