import path from 'node:path';
import { z } from 'zod';
import { configHome, type PathCtx } from '../config/paths.js';
import { readJsonFile, writeJsonFile } from '../util/fs-json.js';
import { hasWorkingLogin } from '../accounts/account-login.js';
import { logCredentialEvent } from '../accounts/credential-log.js';
import { renewalWouldBreakOthers } from '../accounts/duplicate-guard.js';
import { renewAndCarry } from '../accounts/shared-login.js';
import { liveLeases, type LeaseOptions, type SessionLease } from '../session/lease.js';
import { probeUsage, type LimitProbeResult } from './limit-probe.js';
import { refreshCredentialIfExpired, renewalIsDue, expiredLongerThan, type RefreshOutcome } from './oauth-refresh.js';
import { editorPointerAccount } from '../editor/junction.js';

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
/**
 * How long a login must have been expired before ccx will renew one the editor is
 * pointed at. A running Claude refreshes within minutes, so half an hour of
 * nothing means nothing is holding it.
 */
const EDITOR_IDLE_GRACE_MS = 30 * 60_000;

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

/**
 * Persist a snapshot. Exported so renaming an account can move its numbers with
 * it; without that, a rename looks like the usage history was thrown away.
 */
export function writeUsageSnapshot(snapshot: UsageSnapshot, c: PathCtx = {}): void {
  try {
    writeJsonFile(snapshotPath(c), snapshot);
  } catch {
    /* the cache is a convenience, never a hard failure */
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
  /** Injected in tests: how "is a session using this account" is answered. */
  leaseOptions?: LeaseOptions;
  /**
   * Renew an account's token before reading its usage. An account you are not
   * using goes stale within hours, and a stale token cannot report usage, which
   * would hide exactly the accounts rotation wants to move to.
   */
  renew?: (accountDir: string) => Promise<RefreshOutcome>;
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
    options.renew ?? ((accountDir: string) => refreshCredentialIfExpired(accountDir, { ctx: c }));

  const snapshot = readUsageSnapshot(c);
  const aged = accounts.filter((a) => {
    const entry = snapshot.accounts[a.name];
    return !entry || now() - entry.at > maxAge;
  });
  if (aged.length === 0) return snapshot;

  // Accounts a running session is using right now. Renewing one of those would
  // rotate the token out from under the live session, which is what produces a
  // sudden "Login expired" mid-work. Their live copy is read instead: it is the
  // one Claude keeps fresh, so usage still updates without touching anything.
  // Looked up only once there is something to refresh, so the common no-op call
  // does not pay for a directory listing and a parse per file.
  const inUse = new Map(
    liveLeases(c, options.leaseOptions ?? {}).map((l) => [l.account, l] as const),
  );

  // Skip the logins there is no point probing, but only AFTER the leases are
  // known. A running session holds its own copy of the credential and keeps it
  // fresh, so the profile copy can be an older one that has since been refused
  // while the session's copy works. Judging by the profile copy alone would stop
  // refreshing usage for an account that is being used right now, and stale
  // usage is what the rotation policy reads to decide where to move next.
  const stale = aged.filter((a) => inUse.has(a.name) || hasWorkingLogin(a.dir, c));
  if (stale.length === 0) return snapshot;

  // The editor reads an account's login DIRECTLY through its pointer, so ccx is
  // not in the loop for those sessions and cannot tell whether one is running.
  // Renewing that login can sign the editor out exactly as it used to sign
  // terminal sessions out, so it is left alone. The exception keeps usage
  // readable: a live Claude refreshes its own token within minutes of expiry, so
  // a token that has been dead far longer than that is held by nothing, and
  // renewing it is safe. Without that exception, an idle editor account's usage
  // would go stale for good.
  const editorAccount = editorPointerAccount(accounts, c);

  // Sequential, with a small gap: the usage endpoint has a small budget and
  // asking for several accounts at once gets most of them turned away.
  for (const account of stale) {
    let result: LimitProbeResult;
    try {
      // Two reasons never to renew, both of which END a login rather than
      // refreshing it. In both cases only the RENEWAL is skipped, not the
      // account: reading usage does not need us to renew anything, so the
      // numbers still update and the entry still gets stamped. The reason is
      // recorded only when a renewal was actually due, otherwise every refresh
      // would append the same line forever.

      const siblings = renewalWouldBreakOthers(account, accounts);
      // A profile sharing this login is only a reason to refuse when a SESSION
      // is using it. Refusing whenever a sibling existed was symmetric, so for
      // a duplicated account neither half was ever renewed here: both tokens
      // expired, their usage became unreadable, and the rotation policy went
      // blind on exactly the accounts it was meant to choose between. The
      // renewal is carried across to them instead.
      const editorMayBeUsingIt =
        account.name === editorAccount && !expiredLongerThan(account.dir, EDITOR_IDLE_GRACE_MS);
      // Read FRESH, at the moment of the decision, rather than from the map
      // built before the loop. This loop makes a network call per account and
      // sleeps between them, so seconds pass and a session can start in that
      // window; renewing then rotates the token out from under a session that
      // had just claimed it. One read covers this account AND the profiles that
      // share its login, because renewing breaks a session on any of them.
      const busy = leasedAccounts(c, options.leaseOptions ?? {});
      const inSessionNow = [account.name, ...siblings].filter((name) => busy.has(name));
      // The SAME fresh answer decides which credential to probe. A session that
      // started mid-refresh holds a newer copy than the profile does, and reading
      // the profile would report usage for a credential nobody is using.
      const lease = busy.get(account.name);
      const refusal =
        inSessionNow.length > 0
          ? `not renewed: a session is using ${inSessionNow.join(', ')}; renewing would sign it out`
          : editorMayBeUsingIt
            ? 'not renewed: your editor is pointed at this account and may be using it'
            : null;
      const mayRenew = refusal === null;
      if (refusal && renewalIsDue(account.dir)) {
        logCredentialEvent({ account: account.name, kind: 'refused', detail: refusal }, c);
      }
      // Renewal rotates the token, so it is the single most likely reason a
      // login stops working. Record what happened, with the reason.
      const { result: renewal, carried } = mayRenew
        ? await renewAndCarry(account, accounts, siblings, () => renew(account.dir))
        : { result: { status: 'not-needed' as const }, carried: [] as string[] };
      if (renewal.status === 'refreshed') {
        logCredentialEvent({ account: account.name, kind: 'renewed' }, c);
        for (const name of carried) {
          logCredentialEvent(
            {
              account: name,
              kind: 'installed',
              detail: `shares a login with "${account.name}", which was just renewed; carried across so this one keeps working`,
            },
            c,
          );
        }
      } else if (renewal.status === 'needs-login' && !renewal.alreadyKnown) {
        // Only the FIRST refusal for a given login is recorded. The answer
        // cannot change until the credential does, so repeating it every few
        // minutes buries the log that is read to work out why a login broke.
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
      // The live session's copy is the one being kept fresh, so for a leased
      // account that is the file to read. The profile's copy may be older.
      result = await probe(path.join(lease?.configDir ?? account.dir, '.credentials.json'));
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

/**
 * Which accounts a session holds RIGHT NOW, with the lease records.
 *
 * Deliberately a fresh read rather than a cached map: it is asked immediately
 * before a renewal, and the point is to see claims made since the refresh
 * started. The whole RECORD is kept, not just the name, because the same answer
 * decides which credential to probe: a session started mid-refresh holds a
 * newer copy than the profile, and reading the profile instead would report
 * usage for a credential nobody is using.
 */
function leasedAccounts(c: PathCtx, options: LeaseOptions): Map<string, SessionLease> {
  return new Map(liveLeases(c, options).map((lease) => [lease.account, lease] as const));
}
