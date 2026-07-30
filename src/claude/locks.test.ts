import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  acquireLockDir,
  withCredentialLock,
  withCredentialLockIfFree,
  CREDENTIALS_LOCK_DIR,
} from './locks.js';

function dir(): string {
  return mkdtempSync(path.join(tmpdir(), 'cas-lock-'));
}

describe('acquireLockDir', () => {
  it('acquires a free lock and releases it', () => {
    const lock = path.join(dir(), 'x.lock');
    const h = acquireLockDir(lock);
    expect(h.held).toBe(true);
    expect(existsSync(lock)).toBe(true);
    h.release();
    expect(existsSync(lock)).toBe(false);
    h.release(); // idempotent
  });

  it('does not steal a FRESH lock, and proceeds unheld within the bounded wait', () => {
    const lock = path.join(dir(), 'x.lock');
    mkdirSync(lock); // someone else holds it, mtime is now
    const started = Date.now();
    const h = acquireLockDir(lock, { waitMs: 120 });
    expect(h.held).toBe(false); // never blocks the swap forever
    expect(Date.now() - started).toBeLessThan(3000);
    expect(existsSync(lock)).toBe(true); // and we did not remove theirs
    h.release();
    expect(existsSync(lock)).toBe(true); // releasing an unheld lock is a no-op
  });

  it('takes over a STALE lock left by a dead process', () => {
    const lock = path.join(dir(), 'x.lock');
    mkdirSync(lock);
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);
    const h = acquireLockDir(lock, { staleMs: 60_000, waitMs: 200 });
    expect(h.held).toBe(true);
    h.release();
  });

  it('proceeds unheld (never throws) when the lock path is unusable', () => {
    // Parent does not exist and recursive creation is off -> ENOENT, not EEXIST.
    const h = acquireLockDir(path.join(dir(), 'missing', 'deep', 'x.lock'), { waitMs: 50 });
    expect(h.held).toBe(false);
    expect(() => h.release()).not.toThrow();
  });
});

describe('withCredentialLock', () => {
  it('locks Claude\'s credential lock dir for the config dir and always releases', () => {
    const cfg = dir();
    const lockPath = path.join(cfg, CREDENTIALS_LOCK_DIR);
    const seen = withCredentialLock(cfg, () => existsSync(lockPath));
    expect(seen).toBe(true); // held during the callback
    expect(existsSync(lockPath)).toBe(false); // released after
  });

  it('releases the lock even when the callback throws', () => {
    const cfg = dir();
    expect(() =>
      withCredentialLock(cfg, () => {
        throw new Error('swap failed');
      }),
    ).toThrow('swap failed');
    expect(existsSync(path.join(cfg, CREDENTIALS_LOCK_DIR))).toBe(false);
  });
});

describe('withCredentialLockIfFree', () => {
  it('runs the work and reports that it held the lock', () => {
    const cfg = dir();
    let ran = false;
    const held = withCredentialLockIfFree(cfg, () => {
      ran = true;
      expect(existsSync(path.join(cfg, CREDENTIALS_LOCK_DIR))).toBe(true);
    });
    expect(held).toBe(true);
    expect(ran).toBe(true);
    expect(existsSync(path.join(cfg, CREDENTIALS_LOCK_DIR))).toBe(false); // released
  });

  it('SKIPS instead of waiting when something else holds the lock', () => {
    // The point of this variant. The wait inside acquireLockDir is a synchronous
    // sleep loop of up to two seconds, and the caller runs on the timer that also
    // relays the session's output, so waiting would freeze the terminal.
    const cfg = dir();
    mkdirSync(path.join(cfg, CREDENTIALS_LOCK_DIR), { recursive: true });
    const startedAt = Date.now();
    let ran = false;
    const held = withCredentialLockIfFree(cfg, () => {
      ran = true;
    });
    expect(held).toBe(false);
    expect(ran).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(500); // returned promptly
    // Someone else's lock is left exactly where it was.
    expect(existsSync(path.join(cfg, CREDENTIALS_LOCK_DIR))).toBe(true);
  });

  it('releases the lock even when the work throws', () => {
    const cfg = dir();
    expect(() =>
      withCredentialLockIfFree(cfg, () => {
        throw new Error('mirror failed');
      }),
    ).toThrow('mirror failed');
    expect(existsSync(path.join(cfg, CREDENTIALS_LOCK_DIR))).toBe(false);
  });
});
