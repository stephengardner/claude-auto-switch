import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, utimesSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  acquireLockDir,
  acquireOwnedLock,
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

describe('acquireOwnedLock', () => {
  const minutesAgo = (lock: string, minutes: number): void => {
    const then = new Date(Date.now() - minutes * 60_000);
    utimesSync(lock, then, then);
  };
  const owner = (lock: string): string => readFileSync(lock, 'utf8');

  it('takes a free lock, names its holder in it, and releases it', () => {
    const lock = path.join(dir(), 'x.lock');
    const h = acquireOwnedLock(lock, { waitMs: 0, staleMs: 5_000 });
    expect(h.held).toBe(true);
    expect(owner(lock)).toBe(String(process.pid));
    h.release();
    expect(existsSync(lock)).toBe(false);
    h.release(); // idempotent
  });

  it('never takes over a running holder for age alone', () => {
    // A holder working synchronously cannot refresh its lock, so the lock's age
    // says nothing about whether it is still at work.
    const lock = path.join(dir(), 'x.lock');
    const holder = acquireOwnedLock(lock, { waitMs: 0, staleMs: 5_000 });
    minutesAgo(lock, 0.5);
    const other = acquireOwnedLock(lock, { waitMs: 100, staleMs: 5_000 });
    expect(other.held).toBe(false);
    expect(owner(lock)).toBe(String(process.pid));
    holder.release();
  });

  it('takes over at once the lock of a holder that has exited', () => {
    const lock = path.join(dir(), 'x.lock');
    writeFileSync(lock, '4242', 'utf8'); // fresh, but its holder is gone
    const h = acquireOwnedLock(lock, {
      waitMs: 0,
      staleMs: 5_000,
      isRunning: (pid) => pid !== 4242,
    });
    expect(h.held).toBe(true);
    expect(owner(lock)).toBe(String(process.pid));
    h.release();
  });

  it('takes over a running holder past the longest hold, since its pid may have been reused', () => {
    const lock = path.join(dir(), 'x.lock');
    writeFileSync(lock, String(process.pid), 'utf8');
    minutesAgo(lock, 2);
    const h = acquireOwnedLock(lock, { waitMs: 0, staleMs: 5_000, maxHoldMs: 60_000 });
    expect(h.held).toBe(true);
    h.release();
  });

  it('judges a lock that names no holder by its age, as an older build leaves it', () => {
    const lock = path.join(dir(), 'x.lock');
    mkdirSync(lock); // older builds hold this path as a directory
    expect(acquireOwnedLock(lock, { waitMs: 0, staleMs: 5_000 }).held).toBe(false);
    minutesAgo(lock, 1);
    const h = acquireOwnedLock(lock, { waitMs: 0, staleMs: 5_000 });
    expect(h.held).toBe(true);
    expect(owner(lock)).toBe(String(process.pid));
    h.release();
  });

  it('does not remove a lock another process took over a moment before it', () => {
    // Two processes judge the same abandoned lock. The first replaces it with
    // its own; the second must not then remove that one, or both go ahead.
    const lock = path.join(dir(), 'x.lock');
    writeFileSync(lock, '4242', 'utf8');
    const isRunning = (pid: number): boolean => {
      if (pid === 4242 && owner(lock) === '4242') {
        rmSync(lock);
        writeFileSync(lock, '5353', 'utf8'); // the first taker, now holding
      }
      return pid !== 4242;
    };
    const h = acquireOwnedLock(lock, { waitMs: 0, staleMs: 5_000, isRunning });
    expect(h.held).toBe(false);
    expect(owner(lock)).toBe('5353');
  });

  it("waits through Windows' refusals while the last holder's lock is still being removed", () => {
    const lock = path.join(dir(), 'x.lock');
    let attempts = 0;
    const create = (file: string): void => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('delete pending'), { code: 'EPERM' });
      writeFileSync(file, String(process.pid), { flag: 'wx' });
    };
    const h = acquireOwnedLock(lock, { waitMs: 10_000, staleMs: 5_000, create, platform: 'win32' });
    expect(h.held).toBe(true);
    expect(attempts).toBe(3);
    h.release();

    attempts = 0;
    const elsewhere = acquireOwnedLock(path.join(dir(), 'y.lock'), {
      waitMs: 10_000,
      staleMs: 5_000,
      create,
      platform: 'linux',
    });
    expect(elsewhere.held).toBe(false); // EPERM there means the path is unusable
    expect(attempts).toBe(1);
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
