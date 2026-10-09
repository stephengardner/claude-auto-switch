import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { acquireLockDir } from '../claude/locks.js';
import { configHome, type PathCtx } from '../config/paths.js';
import { processIsAlive } from './lease.js';

/**
 * Which account a worker has just picked, said the moment it picks.
 *
 * Workers spread out by avoiding accounts other sessions are on, which they
 * learn from the session leases. But a lease is written only once the login is
 * in place, a little after the pick, and workers are usually started together:
 * each read the leases before any had written one, and they all picked the
 * same account. So a worker picks under a lock every worker shares, and writes
 * a claim before letting go; the next one to pick sees it.
 *
 * A bridge until the lease exists, so a claim counts for CLAIM_TTL_MS at most,
 * and only while the process that made it is alive. It is not a lease: a lease
 * also holds off login renewals and names the folder a session reads its login
 * from, and a claim is made before there is any login in that folder.
 */

/** Long enough for a start to get from its pick to its lease, renewing a login on the way. */
export const CLAIM_TTL_MS = 60_000;
/** How long a worker waits for another's pick before picking anyway. */
const PICK_WAIT_MS = 5000;

interface Claim {
  account: string;
  pid: number;
  at: number;
}

export interface ClaimOptions {
  now?: () => number;
  /** Injected in tests; defaults to a real liveness check on the pid. */
  isAlive?: (pid: number) => boolean;
  /** This process, as far as claims go; injected in tests. */
  pid?: number;
}

function claimsDir(c: PathCtx): string {
  return path.join(configHome(c), 'worker-claims');
}

function claimPath(c: PathCtx, pid: number): string {
  return path.join(claimsDir(c), `${pid}.json`);
}

function isClaim(value: unknown): value is Claim {
  if (value === null || typeof value !== 'object') return false;
  const claim = value as Record<string, unknown>;
  return typeof claim.account === 'string' && Number.isInteger(claim.pid) && typeof claim.at === 'number';
}

/** Say that this process has picked `account`. */
export function claimAccount(account: string, c: PathCtx = {}, options: ClaimOptions = {}): void {
  const pid = options.pid ?? process.pid;
  const claim: Claim = { account, pid, at: (options.now ?? Date.now)() };
  try {
    mkdirSync(claimsDir(c), { recursive: true });
    writeFileSync(claimPath(c, pid), JSON.stringify(claim), 'utf8');
  } catch {
    /* Best effort: spreading out is a preference, never a reason not to start. */
  }
}

/** Withdraw this process's claim. */
export function releaseClaim(c: PathCtx = {}, options: ClaimOptions = {}): void {
  try {
    rmSync(claimPath(c, options.pid ?? process.pid), { force: true });
  } catch {
    /* already gone */
  }
}

/** The accounts another live worker has claimed within CLAIM_TTL_MS. */
export function claimedElsewhere(c: PathCtx = {}, options: ClaimOptions = {}): Set<string> {
  const now = (options.now ?? Date.now)();
  const isAlive = options.isAlive ?? processIsAlive;
  const own = options.pid ?? process.pid;
  const claimed = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(claimsDir(c));
  } catch {
    return claimed; // no folder yet: no worker has picked
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(claimsDir(c), name);
    let claim: unknown;
    try {
      claim = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue; // being written, or not a claim
    }
    if (!isClaim(claim) || claim.pid === own) continue;
    if (now - claim.at > CLAIM_TTL_MS || !isAlive(claim.pid)) {
      // Its lease, if it has one, says the rest from here.
      rmSync(file, { force: true });
      continue;
    }
    claimed.add(claim.account);
  }
  return claimed;
}

/**
 * Pick and claim as one step, under the lock every worker shares, so the next
 * worker to pick sees this one's claim. Bounded: a worker that cannot get the
 * lock in time picks anyway, as it would have without one.
 */
export function pickAndClaim<T extends { name: string }>(pick: () => T | null, c: PathCtx = {}): T | null {
  try {
    mkdirSync(configHome(c), { recursive: true });
  } catch {
    /* the lock then cannot be taken, and the pick goes ahead without it */
  }
  const lock = acquireLockDir(path.join(configHome(c), 'worker-pick.lock'), { waitMs: PICK_WAIT_MS });
  try {
    const picked = pick();
    if (picked) claimAccount(picked.name, c);
    return picked;
  } finally {
    lock.release();
  }
}
