import path from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { configHome, type PathCtx } from '../config/paths.js';
import { readJsonFile, writeJsonFile } from '../util/fs-json.js';
import { readToken } from '../daemon/token-store.js';
import { probeUsage, type LimitProbeResult } from './limit-probe.js';

/**
 * Cached per-account subscription usage (5h/7d utilization + resets), fetched
 * from the unified rate-limit headers with one minimal request per account.
 * Cached with a TTL so the dashboard can render usage every tick while the
 * network is touched at most once per account per TTL window.
 */

const ModelSchema = z.object({
  name: z.string(),
  utilization: z.number(),
  resetsAt: z.number().nullable().optional(),
});
const EntrySchema = z.object({
  fiveHour: z.number().nullable(),
  sevenDay: z.number().nullable(),
  fiveHourReset: z.number().nullable(),
  sevenDayReset: z.number().nullable(),
  /** Per-model weekly windows (Fable, ...). */
  models: z.array(ModelSchema).optional(),
  /** When this entry was fetched (epoch ms). */
  at: z.number(),
});
const SnapshotSchema = z.object({ accounts: z.record(z.string(), EntrySchema) });

export type UsageEntry = z.infer<typeof EntrySchema>;
export type UsageSnapshot = z.infer<typeof SnapshotSchema>;

const FILENAME = 'usage-snapshot.json';
export const USAGE_TTL_MS = 5 * 60_000;

function snapshotPath(c: PathCtx = {}): string {
  return path.join(configHome(c), FILENAME);
}

/** The cached snapshot; malformed or absent reads as empty (never throws). */
export function readUsageSnapshot(c: PathCtx = {}): UsageSnapshot {
  try {
    return readJsonFile(snapshotPath(c), SnapshotSchema) ?? { accounts: {} };
  } catch {
    return { accounts: {} };
  }
}

export interface RefreshableAccount {
  name: string;
  dir: string;
}

export interface RefreshUsageOptions {
  maxAgeMs?: number;
  now?: () => number;
  /** Injected in tests; defaults to the real API probe. */
  probe?: (credentialsFile: string) => Promise<LimitProbeResult>;
}

function hasLogin(dir: string): boolean {
  return existsSync(path.join(dir, '.credentials.json')) || readToken(dir) !== null;
}

/**
 * Refresh stale entries (older than the TTL) with one minimal probe each, in
 * parallel, and persist the merged snapshot. Fresh entries are not refetched.
 * A failed probe stores nulls WITH a timestamp so a broken network is retried
 * once per TTL, not every tick.
 */
export async function refreshUsage(
  accounts: RefreshableAccount[],
  c: PathCtx = {},
  options: RefreshUsageOptions = {},
): Promise<UsageSnapshot> {
  const maxAge = options.maxAgeMs ?? USAGE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const probe =
    options.probe ?? ((file: string) => probeUsage(file));

  const snapshot = readUsageSnapshot(c);
  const stale = accounts.filter((a) => {
    if (!hasLogin(a.dir)) return false;
    const entry = snapshot.accounts[a.name];
    return !entry || now() - entry.at > maxAge;
  });
  if (stale.length === 0) return snapshot;

  const results = await Promise.all(
    stale.map(async (a) => {
      try {
        const r = await probe(path.join(a.dir, '.credentials.json'));
        return { name: a.name, r };
      } catch {
        return { name: a.name, r: { verdict: 'unknown' } as LimitProbeResult };
      }
    }),
  );
  for (const { name, r } of results) {
    snapshot.accounts[name] = {
      fiveHour: r.fiveHour ?? null,
      sevenDay: r.sevenDay ?? null,
      fiveHourReset: r.fiveHourReset ?? null,
      sevenDayReset: r.sevenDayReset ?? null,
      ...(r.models ? { models: r.models.map((m) => ({ name: m.name, utilization: m.utilization, resetsAt: m.resetsAt ?? null })) } : {}),
      at: now(),
    };
  }
  try {
    writeJsonFile(snapshotPath(c), snapshot);
  } catch {
    /* cache write is best effort */
  }
  return snapshot;
}
