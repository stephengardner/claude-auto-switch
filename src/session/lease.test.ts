import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
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

  it('ignores a fresh, live lease whose account is not a string', () => {
    // A hand-edited or corrupt lease with a non-string account would satisfy a
    // truthiness check and then reach a consumer that does string work on it
    // (padding a table column), which throws. It is treated as no protection.
    const c = home();
    mkdirSync(path.dirname(leasePath('x', c)), { recursive: true });
    writeFileSync(
      leasePath('x', c, 424242),
      JSON.stringify({ account: 12345, pid: process.pid, configDir: '/s', at: 9_000 }),
      'utf8',
    );
    expect(liveLeases(c, { now: () => 9_100, isAlive: () => true })).toEqual([]);
  });

  it('keeps a valid lease but drops a non-string cwd', () => {
    // cwd is only a display/matching hint. A corrupt value must not reach a
    // consumer that does string work on it (the sessions table), but the lease
    // itself is valid and still protects its account.
    const c = home();
    mkdirSync(path.dirname(leasePath('work', c)), { recursive: true });
    writeFileSync(
      leasePath('work', c, 424242),
      JSON.stringify({ account: 'work', pid: process.pid, configDir: '/s', at: 9_000, cwd: 42 }),
      'utf8',
    );
    const live = liveLeases(c, { now: () => 9_100, isAlive: () => true });
    expect(live).toHaveLength(1);
    expect(live[0]?.account).toBe('work');
    expect(live[0]?.cwd).toBeUndefined();
  });

  it('stays live while the session keeps saying so', () => {
    const c = home();
    let clock = 1_000;
    takeLease('work', '/session', c, { now: () => clock });
    clock += LEASE_STALE_MS - 5;
    expect(touchLease('work', '/session', c, { now: () => clock })).toBe(false);
    clock += LEASE_STALE_MS - 5; // would be stale without the touch
    expect(liveLeases(c, { now: () => clock, isAlive: () => true })).toHaveLength(1);
  });

  it('leaves the announcement of a session that went quiet while its process still runs', () => {
    // A laptop asleep for ten minutes: nothing ticked, so the announcement is
    // long past fresh, and on waking a reader can run before the session does.
    // Removing it there lost the session for good, because nothing wrote it
    // again until the session next changed account.
    const c = home();
    takeLease('work', '/session', c, { now: () => 1_000 });
    const awake = 1_000 + 10 * 60_000;
    expect(liveLeases(c, { now: () => awake, isAlive: () => true })).toEqual([]);
    expect(existsSync(leasePath('work', c))).toBe(true);

    // The session's next tick, and it is listed again.
    touchLease('work', '/session', c, { now: () => awake + 400 });
    const seen = liveLeases(c, { now: () => awake + 500, isAlive: () => true });
    expect(seen.map((l) => l.account)).toEqual(['work']);
  });

  it('still removes a quiet announcement once its process is gone', () => {
    const c = home();
    takeLease('work', '/session', c, { now: () => 1_000 });
    liveLeases(c, { now: () => 1_000 + LEASE_STALE_MS + 1, isAlive: () => false });
    expect(existsSync(leasePath('work', c))).toBe(false);
  });

  it('announces again when its announcement was removed while it runs', () => {
    // A reader from ccx 2.3.2 or older, still running on the same machine,
    // removes a quiet announcement whether or not its process is alive.
    const c = home();
    takeLease('work', '/session', c, { now: () => 1_000, cwd: '/project' });
    rmSync(leasePath('work', c));

    expect(touchLease('work', '/session', c, { now: () => 2_000, cwd: '/project' })).toBe(true);
    expect(leaseFor('work', c, { now: () => 2_100 })).toEqual({
      account: 'work',
      pid: process.pid,
      configDir: '/session',
      cwd: '/project',
      at: 2_000,
    });
  });

  it('announces again over an announcement of its own that cannot be read', () => {
    // Its own file, cut short by a write that never finished: unreadable to
    // every reader, so the session would stay unlisted while it ran.
    const c = home();
    takeLease('work', '/session', c, { now: () => 1_000 });
    writeFileSync(leasePath('work', c), '{"account":"wor', 'utf8');

    expect(touchLease('work', '/session', c, { now: () => 2_000 })).toBe(true);
    expect(leaseFor('work', c, { now: () => 2_100 })?.configDir).toBe('/session');
  });

  it('releasing it stops the protection', () => {
    const c = home();
    takeLease('work', '/session', c);
    releaseLease('work', c);
    expect(existsSync(leasePath('work', c))).toBe(false);
  });

  it('lets several sessions announce ONE account at the same time', () => {
    // The file was per-account, so the last session to start silently took the
    // only slot: the others could not refresh the announcement and their
    // protection lapsed while they ran. One file per session ends that.
    const c = home();
    takeLease('work', '/session-a', c, { now: () => 1_000 });
    // A second session of the same account, written as another pid would.
    mkdirSync(path.dirname(leasePath('work', c)), { recursive: true });
    writeFileSync(
      leasePath('work', c, 424242),
      JSON.stringify({ account: 'work', pid: process.pid, configDir: '/session-b', at: 2_000 }),
      'utf8',
    );
    const live = liveLeases(c, { now: () => 2_500 });
    expect(live).toHaveLength(2);
    expect(live.map((l) => l.configDir).sort()).toEqual(['/session-a', '/session-b']);
  });

  it('answers leaseFor with the most recently refreshed session', () => {
    // That is the session whose copy of the login is most plausibly freshest,
    // which is what usage reading wants.
    const c = home();
    takeLease('work', '/session-old', c, { now: () => 1_000 });
    writeFileSync(
      leasePath('work', c, 424242),
      JSON.stringify({ account: 'work', pid: process.pid, configDir: '/session-new', at: 5_000 }),
      'utf8',
    );
    expect(leaseFor('work', c, { now: () => 5_500 })?.configDir).toBe('/session-new');
  });

  it('still reads a lease written before the pid suffix existed', () => {
    // Reading is by CONTENT: an old <account>.json from a session that has not
    // restarted must keep counting.
    const c = home();
    mkdirSync(path.dirname(leasePath('work', c)), { recursive: true });
    const legacy = path.join(path.dirname(leasePath('work', c)), 'work.json');
    writeFileSync(
      legacy,
      JSON.stringify({ account: 'work', pid: process.pid, configDir: '/old-session', at: 1_000 }),
      'utf8',
    );
    expect(liveLeases(c, { now: () => 1_500 })).toHaveLength(1);
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

    expect(touchLease('work', '/mine', c, { now: () => 9_999 })).toBe(false);
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

  it('treats a file that parses to something other than an object as absent', () => {
    // Valid JSON is not a lease: `null` parses, and reading a field off it
    // throws, which took down every reader, the status line included.
    const c = home();
    takeLease('work', '/session', c);
    mkdirSync(path.dirname(leasePath('work', c)), { recursive: true });
    writeFileSync(leasePath('null', c), 'null', 'utf8');
    writeFileSync(leasePath('number', c), '42', 'utf8');
    expect(liveLeases(c).map((l) => l.account)).toEqual(['work']);
  });
});
