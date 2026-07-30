import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  takeLease,
  touchLease,
  releaseLease,
  liveLeases,
  leaseFor,
  leasePath,
  LEASE_STALE_MS,
} from './lease.js';

function home(): { env: Record<string, string> } {
  return { env: { CLAUDE_AUTO_SWITCH_HOME: mkdtempSync(path.join(tmpdir(), 'cas-lease-')) } };
}

describe('session leases', () => {
  it('reports an account a running session announced', () => {
    const c = home();
    takeLease('work', '/session', c);
    expect(liveLeases(c).map((l) => l.account)).toEqual(['work']);
    expect(leaseFor('work', c)?.configDir).toBe('/session');
    expect(leaseFor('other', c)).toBeNull();
  });

  it('reports nothing when no session has ever run', () => {
    expect(liveLeases(home())).toEqual([]);
  });

  it('ignores an announcement whose process is gone', () => {
    const c = home();
    takeLease('work', '/session', c);
    // A session that was killed leaves its file behind. It must not keep the
    // account protected forever, or renewals would stop permanently.
    expect(liveLeases(c, { isAlive: () => false })).toEqual([]);
  });

  it('ignores an announcement that went quiet, even if some process has that id', () => {
    const c = home();
    takeLease('work', '/session', c, { now: () => 1_000 });
    const muchLater = 1_000 + LEASE_STALE_MS + 1;
    expect(liveLeases(c, { now: () => muchLater, isAlive: () => true })).toEqual([]);
  });

  it('cleans up the file it ignored, so the folder cannot grow forever', () => {
    const c = home();
    takeLease('work', '/session', c);
    liveLeases(c, { isAlive: () => false });
    expect(existsSync(leasePath('work', c))).toBe(false);
  });

  it('stays live while the session keeps saying so', () => {
    const c = home();
    let clock = 1_000;
    takeLease('work', '/session', c, { now: () => clock });
    clock += LEASE_STALE_MS - 5;
    touchLease('work', c, { now: () => clock });
    clock += LEASE_STALE_MS - 5; // would be stale without the touch
    expect(liveLeases(c, { now: () => clock, isAlive: () => true })).toHaveLength(1);
  });

  it('releasing it stops the protection', () => {
    const c = home();
    takeLease('work', '/session', c);
    releaseLease('work', c);
    expect(liveLeases(c)).toEqual([]);
  });

  it('never touches or releases another session\'s announcement', () => {
    const c = home();
    // Written by hand with a different pid: another running session.
    mkdirSync(path.dirname(leasePath('work', c)), { recursive: true });
    writeFileSync(
      leasePath('work', c),
      JSON.stringify({ account: 'work', pid: process.pid + 1, configDir: '/other', at: 5_000 }),
      'utf8',
    );

    touchLease('work', c, { now: () => 9_999 });
    releaseLease('work', c);

    // Still there, and still stamped with ITS time, not ours. Otherwise one
    // session could keep another's account protected after that one died.
    expect(existsSync(leasePath('work', c))).toBe(true);
    expect(leaseFor('work', c, { now: () => 5_100, isAlive: () => true })?.at).toBe(5_000);
  });

  it('treats an unreadable file as absent rather than as protection', () => {
    const c = home();
    mkdirSync(path.dirname(leasePath('work', c)), { recursive: true });
    writeFileSync(leasePath('work', c), 'not json at all', 'utf8');
    expect(liveLeases(c)).toEqual([]);
  });
});
