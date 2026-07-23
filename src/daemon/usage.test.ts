import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseUsageCache, readUsageForDir } from './usage.js';

// Exact shape captured from a real ~/.claude/usage-cache.json.
const real = JSON.stringify({
  schema_version: 1,
  five_hour: 94,
  seven_day: 19,
  seven_day_sonnet: null,
  five_hour_resets_at: '2026-07-16T02:40:00.437507+00:00',
  seven_day_resets_at: '2026-07-22T18:00:00.437531+00:00',
  fetched_at: '2026-07-16T01:20:30.969Z',
  stale: false,
  retry_after: null,
});

describe('parseUsageCache', () => {
  it('maps the real cache fields', () => {
    const u = parseUsageCache(real);
    expect(u.fiveHourPct).toBe(94);
    expect(u.sevenDayPct).toBe(19);
    expect(u.retryAfter).toBeNull();
    expect(u.stale).toBe(false);
    expect(u.fiveHourResetsAt).toBe(Date.parse('2026-07-16T02:40:00.437507+00:00'));
  });

  it('treats a present retry_after as a number', () => {
    const u = parseUsageCache(JSON.stringify({ five_hour: 100, retry_after: 1800 }));
    expect(u.retryAfter).toBe(1800);
    expect(u.fiveHourPct).toBe(100);
  });
});

describe('readUsageForDir', () => {
  it('reads the cache from a config dir', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-usage-'));
    writeFileSync(path.join(dir, 'usage-cache.json'), real, 'utf8');
    expect(readUsageForDir(dir)?.fiveHourPct).toBe(94);
  });

  it('returns null when there is no cache', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-usage-'));
    expect(readUsageForDir(dir)).toBeNull();
  });
});
