import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { probeLimit, probeUsage } from './limit-probe.js';

function credsFile(withToken = true): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-probe-'));
  const file = path.join(dir, '.credentials.json');
  writeFileSync(
    file,
    JSON.stringify(withToken ? { claudeAiOauth: { accessToken: 'tok-123' } } : {}),
    'utf8',
  );
  return file;
}

/** A fake fetch returning the given usage JSON (or a status for error cases). */
function usageFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

const HEALTHY = {
  five_hour: { utilization: 8, resets_at: '2026-07-29T06:00:00Z' },
  seven_day: { utilization: 2, resets_at: '2026-08-01T12:00:00Z' },
  limits: [
    { kind: 'session', percent: 8, severity: 'normal', is_active: true },
    { kind: 'weekly_all', percent: 2, severity: 'normal', is_active: false },
    {
      kind: 'weekly_scoped',
      percent: 78,
      severity: 'warning',
      resets_at: '2026-08-04T00:00:00Z',
      is_active: true,
      scope: { model: { display_name: 'Fable' } },
    },
  ],
};

describe('probeUsage', () => {
  it('parses windows, resets, and per-model rows from the usage endpoint', async () => {
    const r = await probeUsage(credsFile(), usageFetch(HEALTHY));
    expect(r.verdict).toBe('allowed');
    expect(r.fiveHour).toBeCloseTo(0.08);
    expect(r.sevenDay).toBeCloseTo(0.02);
    expect(r.fiveHourReset).toBe(Date.parse('2026-07-29T06:00:00Z'));
    expect(r.models).toEqual([
      expect.objectContaining({ name: 'Fable', utilization: 0.78, severity: 'warning' }),
    ]);
  });
});

describe('probeLimit verdict', () => {
  it('allowed when nothing is at the limit', async () => {
    expect((await probeLimit(credsFile(), '', usageFetch(HEALTHY))).verdict).toBe('allowed');
  });

  it('limited when the 5-hour window is at 100%', async () => {
    const body = { ...HEALTHY, five_hour: { utilization: 100 }, limits: [] };
    expect((await probeLimit(credsFile(), '', usageFetch(body))).verdict).toBe('limited');
  });

  it('limited via a named model window even when all-models looks healthy', async () => {
    const body = {
      five_hour: { utilization: 10 },
      seven_day: { utilization: 20 },
      limits: [
        { kind: 'weekly_all', percent: 20, is_active: true },
        {
          kind: 'weekly_scoped',
          percent: 100,
          severity: 'warning',
          is_active: true,
          scope: { model: { display_name: 'Fable' } },
        },
      ],
    };
    // The cap text names Fable -> decide from Fable's window, not the healthy overall.
    const r = await probeLimit(credsFile(), "You've reached your Fable 5 limit.", usageFetch(body));
    expect(r.verdict).toBe('limited');
    expect(r.detail).toMatch(/Fable/);
  });

  it('limited when an active limit reports an exhausted severity', async () => {
    const body = {
      five_hour: { utilization: 40 },
      limits: [{ kind: 'session', percent: 40, severity: 'exhausted', is_active: true }],
    };
    expect((await probeLimit(credsFile(), '', usageFetch(body))).verdict).toBe('limited');
  });

  it('is fail-safe: no token, non-200, or a network error is unknown (never limited)', async () => {
    expect((await probeLimit(credsFile(false), '', usageFetch({}))).verdict).toBe('unknown');
    expect((await probeLimit(credsFile(), '', usageFetch({}, 401))).verdict).toBe('unknown');
    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect((await probeLimit(credsFile(), '', boom)).verdict).toBe('unknown');
  });
});
