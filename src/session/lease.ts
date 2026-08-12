import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { configHome, type PathCtx } from '../config/paths.js';

/**
 * Which accounts are being used by a running session right now.
 *
 * This exists because renewing a login ROTATES it: the token that was valid a
 * moment ago stops working as soon as the new one is issued. A running Claude
 * session holds its own copy of the login (ccx copies it into the shared session
 * folder so accounts can be swapped underneath a live process), so when ccx
 * renews that same login behind the session's back, the session is left holding a
 * token the server has already retired. What the operator sees is
 * "Login expired - please run /login" in the middle of working, having done
 * nothing. That is the bug this prevents.
 *
 * A session announces the account it is using by writing a small file, and keeps
 * it warm while it runs. Anything that renews logins skips the accounts named by
 * a live file, and reads usage from the session's own copy instead, which is the
 * fresher one anyway.
 *
 * Crash-safe on purpose: a session that dies without cleaning up leaves its file
 * behind, so a file only counts as live while its process still exists AND it has
 * been touched recently. Either test failing makes it ignorable, so a stale file
 * can never freeze renewals forever.
 */

/** A file older than this is ignored even if some process still has its pid. */
export const LEASE_STALE_MS = 120_000;

export interface SessionLease {
  account: string;
  pid: number;
  /** The config folder the session is actually reading its login from. */
  configDir: string;
  /** Last time the session said it was still going. */
  at: number;
}

export interface LeaseOptions {
  now?: () => number;
  /** Injected in tests; defaults to a real liveness check on the pid. */
  isAlive?: (pid: number) => boolean;
}

function leasesDir(c: PathCtx): string {
  return path.join(configHome(c), 'sessions-live');
}

/**
 * Where THIS process's file for a given account lives.
 *
 * Named after the account AND the pid: several sessions can run one account at
 * the same time, and when the file was per-account the last session to start
 * silently took the only slot. The other sessions could not refresh the
 * announcement (not their pid), so their protection lapsed while they ran,
 * which is one of the ways a renewal killed a live session's login. Reading is
 * by CONTENT, so files written before the pid suffix existed still count.
 */
export function leasePath(account: string, c: PathCtx = {}, pid: number = process.pid): string {
  return path.join(leasesDir(c), `${encodeURIComponent(account)}__${pid}.json`);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 checks for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else, which still counts.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Announce that this process is now using `account`, reading from `configDir`. */
export function takeLease(
  account: string,
  configDir: string,
  c: PathCtx = {},
  options: LeaseOptions = {},
): void {
  const now = options.now ?? (() => Date.now());
  const lease: SessionLease = { account, pid: process.pid, configDir, at: now() };
  try {
    mkdirSync(leasesDir(c), { recursive: true });
    writeFileSync(leasePath(account, c), JSON.stringify(lease), 'utf8');
  } catch {
    /* Best effort: failing to announce must never stop a session from starting. */
  }
}

/**
 * Say the session is still going.
 *
 * Only refreshes our OWN file. Touching another process's would keep its account
 * protected after it died, which is the failure this design is built to avoid.
 */
export function touchLease(account: string, c: PathCtx = {}, options: LeaseOptions = {}): void {
  const now = options.now ?? (() => Date.now());
  try {
    const raw = JSON.parse(readFileSync(leasePath(account, c), 'utf8')) as SessionLease;
    if (raw.pid !== process.pid) return;
    writeFileSync(leasePath(account, c), JSON.stringify({ ...raw, at: now() }), 'utf8');
  } catch {
    /* nothing to touch */
  }
}

/** Give up the announcement for `account`, if it is ours. */
export function releaseLease(account: string, c: PathCtx = {}): void {
  try {
    const raw = JSON.parse(readFileSync(leasePath(account, c), 'utf8')) as SessionLease;
    if (raw.pid !== process.pid) return; // never delete another session's
    rmSync(leasePath(account, c), { force: true });
  } catch {
    /* already gone */
  }
}

/**
 * Every account a running session is using right now.
 *
 * Files whose process is gone, or that have not been touched recently, are
 * ignored and cleaned up, so a crashed session cannot block renewals forever.
 */
export function liveLeases(c: PathCtx = {}, options: LeaseOptions = {}): SessionLease[] {
  const now = options.now ?? (() => Date.now());
  const isAlive = options.isAlive ?? processIsAlive;
  let names: string[];
  try {
    names = readdirSync(leasesDir(c));
  } catch {
    return []; // no folder yet: nothing is running
  }
  const live: SessionLease[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(leasesDir(c), name);
    let lease: SessionLease;
    try {
      lease = JSON.parse(readFileSync(file, 'utf8')) as SessionLease;
    } catch {
      continue; // unreadable: treat as absent rather than as protection
    }
    const fresh = typeof lease.at === 'number' && now() - lease.at < LEASE_STALE_MS;
    if (!lease.account || !fresh || !isAlive(lease.pid)) {
      // Its own process is the only thing that could refresh it, and that is
      // gone, so the file is litter. Removing it keeps the folder from growing.
      if (!fresh || !isAlive(lease.pid)) {
        try {
          rmSync(file, { force: true });
        } catch {
          /* best effort */
        }
      }
      continue;
    }
    live.push(lease);
  }
  // Oldest first, so a consumer that folds these into a per-account map keeps
  // the FRESHEST announcement, whatever order the directory listed them in.
  return live.sort((a, b) => a.at - b.at);
}

/**
 * The live announcement for one account, or null when nothing is using it.
 * With several sessions on one account, the most recently refreshed one: that
 * is the session whose copy of the login is most plausibly the freshest.
 */
export function leaseFor(
  account: string,
  c: PathCtx = {},
  options: LeaseOptions = {},
): SessionLease | null {
  const mine = liveLeases(c, options).filter((l) => l.account === account);
  return mine[mine.length - 1] ?? null;
}
