import path from 'node:path';
import { z } from 'zod';
import { configHome, type PathCtx } from '../config/paths.js';
import { readJsonFile, writeJsonFile } from '../util/fs-json.js';
import { readToken } from '../daemon/token-store.js';
import { hasUsableLogin } from '../accounts/credential-vault.js';
import { logCredentialEvent } from '../accounts/credential-log.js';
import { probeUsage, type LimitProbeResult } from './limit-probe.js';
import { refreshCredentialIfExpired } from './oauth-refresh.js';

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
  /** Delay between account fetches, to stay inside the endpoint's budget. */
  gapMs?: number;
  /**
   * Renew an account's token before reading its usage. An account you are not
   * using goes stale within hours, and a stale token cannot report usage, which
   * would hide exactly the accounts rotation wants to move to.
   */
  renew?: (accountDir: string) => Promise<{ status: string; detail?: string }>;
}

/**
 * Sleep between fetches. Deliberately NOT unref'd: this runs inside an awaited
 * refresh, and an unref'd timer lets the process exit mid-refresh (which shows
 * up as a command that prints nothing at all).
 */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hasLogin(dir: string): boolean {
  return hasUsableLogin(dir) || readToken(dir) !== null;
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
  const gapMs = options.gapMs ?? 400;
  const probe =
    options.probe ?? ((file: string) => probeUsage(file));
  const renew =
    options.renew ?? ((accountDir: string) => refreshCredentialIfExpired(accountDir));

  const snapshot = readUsageSnapshot(c);
  const stale = accounts.filter((a) => {
    if (!hasLogin(a.dir)) return false;
    const entry = snapshot.accounts[a.name];
    return !entry || now() - entry.at > maxAge;
  });
  if (stale.length === 0) return snapshot;

  // Sequential, with a small gap: the usage endpoint has a small budget and
  // asking for several accounts at once gets most of them turned away.
  for (const account of stale) {
    let result: LimitProbeResult;
    try {
      // Renewal rotates the token, so it is the single most likely reason a
      // login stops working. Record what happened, with the reason.
      const renewal = await renew(account.dir);
      if (renewal.status === 'refreshed') {
        logCredentialEvent({ account: account.name, kind: 'renewed' }, c);
      } else if (renewal.status === 'needs-login') {
        logCredentialEvent(
          { account: account.name, kind: 'needs-login', detail: renewal.detail ?? 'renewal refused' },
          c,
        );
      } else if (renewal.status === 'unavailable') {
        logCredentialEvent(
          { account: account.name, kind: 'renew-failed', detail: renewal.detail ?? 'renewal unavailable' },
          c,
        );
      }
      result = await probe(path.join(account.dir, '.credentials.json'));
    } catch {
      result = { verdict: 'unknown' };
    }

    const known = result.fiveHour !== undefined || result.sevenDay !== undefined;
    if (known) {
      snapshot.accounts[account.name] = {
        fiveHour: result.fiveHour ?? null,
        sevenDay: result.sevenDay ?? null,
        fiveHourReset: result.fiveHourReset ?? null,
        sevenDayReset: result.sevenDayReset ?? null,
        ...(result.models
          ? { models: result.models.map((m) => ({ name: m.name, utilization: m.utilization, resetsAt: m.resetsAt ?? null })) }
          : {}),
        at: now(),
      };
    } else {
      // Could not read it (offline, or the endpoint asked us to slow down).
      // KEEP the last known numbers rather than replacing them with blanks, and
      // just mark the attempt so the next refresh is due after the TTL.
      const previous = snapshot.accounts[account.name];
      snapshot.accounts[account.name] = previous
        ? { ...previous, at: now() }
        : { fiveHour: null, sevenDay: null, fiveHourReset: null, sevenDayReset: null, at: now() };
      if (result.retryAfterMs) await pause(Math.min(result.retryAfterMs, 5_000));
    }
    if (stale.length > 1) await pause(gapMs);
  }
  try {
    writeJsonFile(snapshotPath(c), snapshot);
  } catch {
    /* cache write is best effort */
  }
  return snapshot;
}
