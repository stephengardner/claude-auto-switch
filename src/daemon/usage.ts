import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Normalized view of an account's `usage-cache.json` (written by Claude Code
 * itself, shared by the terminal and the IDE extension). Percentages are 0-100;
 * reset times and fetchedAt are epoch ms; retryAfter is non-null when the
 * account is actively rate-limited.
 */
export interface UsageSnapshot {
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  fiveHourResetsAt: number | null;
  sevenDayResetsAt: number | null;
  retryAfter: number | null;
  fetchedAt: number | null;
  stale: boolean;
}

export function parseUsageCache(text: string): UsageSnapshot {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const isoMs = (v: unknown): number | null => {
    if (typeof v !== 'string') return null;
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  };
  return {
    fiveHourPct: num(raw.five_hour),
    sevenDayPct: num(raw.seven_day),
    fiveHourResetsAt: isoMs(raw.five_hour_resets_at),
    sevenDayResetsAt: isoMs(raw.seven_day_resets_at),
    retryAfter: num(raw.retry_after),
    fetchedAt: isoMs(raw.fetched_at),
    stale: raw.stale === true,
  };
}

/** Read and parse the usage cache for a config dir, or null if absent/unreadable. */
export function readUsageForDir(configDir: string): UsageSnapshot | null {
  const file = path.join(configDir, 'usage-cache.json');
  if (!existsSync(file)) return null;
  try {
    return parseUsageCache(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
