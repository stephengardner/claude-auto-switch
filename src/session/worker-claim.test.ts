import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configHome } from '../config/paths.js';
import { CLAIM_TTL_MS, claimAccount, claimedElsewhere, pickAndClaim, releaseClaim } from './worker-claim.js';

/**
 * Workers started together each read the leases before any had written one,
 * and all picked the same account. A claim made under a shared lock, at the
 * moment of the pick, is what the next worker to pick sees instead.
 */

const ctxIn = (): { env: Record<string, string> } => {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-claim-'));
  return { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
};
const alive = (): boolean => true;

describe('what a worker says it has just picked', () => {
  it("counts another live worker's claim, and never its own", () => {
    const ctx = ctxIn();
    claimAccount('A', ctx, { pid: 111, now: () => 1000 });
    claimAccount('B', ctx, { pid: 222, now: () => 1000 });
    expect(claimedElsewhere(ctx, { pid: 111, now: () => 2000, isAlive: alive })).toEqual(new Set(['B']));
  });

  it('forgets a claim whose worker is gone, or that its lease has long since replaced', () => {
    const ctx = ctxIn();
    claimAccount('A', ctx, { pid: 111, now: () => 1000 });
    claimAccount('B', ctx, { pid: 222, now: () => 1000 });
    const seen = claimedElsewhere(ctx, {
      pid: 999,
      now: () => 1000 + CLAIM_TTL_MS + 1,
      isAlive: (pid) => pid === 111,
    });
    expect(seen).toEqual(new Set());
    // And cleans them up rather than reading them again every time.
    expect(claimedElsewhere(ctx, { pid: 999, now: () => 1000, isAlive: alive })).toEqual(new Set());
  });

  it('takes a claim back when the worker is done', () => {
    const ctx = ctxIn();
    claimAccount('A', ctx, { pid: 111, now: () => 1000 });
    releaseClaim(ctx, { pid: 111 });
    expect(claimedElsewhere(ctx, { pid: 999, now: () => 1000, isAlive: alive })).toEqual(new Set());
  });

  it('picks and claims while holding the lock every worker picks under', () => {
    const ctx = ctxIn();
    const lock = path.join(configHome(ctx), 'worker-pick.lock');
    let heldDuringPick = false;
    const picked = pickAndClaim(() => {
      heldDuringPick = existsSync(lock);
      return { name: 'B' };
    }, ctx);
    expect(picked).toEqual({ name: 'B' });
    expect(heldDuringPick).toBe(true);
    expect(existsSync(lock)).toBe(false);
    expect(claimedElsewhere(ctx, { pid: process.pid + 1, isAlive: alive })).toEqual(new Set(['B']));
  });

  it('claims nothing when there was nothing to pick', () => {
    const ctx = ctxIn();
    expect(pickAndClaim(() => null, ctx)).toBeNull();
    expect(claimedElsewhere(ctx, { pid: process.pid + 1, isAlive: alive })).toEqual(new Set());
  });
});
