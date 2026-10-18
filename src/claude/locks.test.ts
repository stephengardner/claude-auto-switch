import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  utimesSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  acquireLockDir,
  acquireOwnedLock,
  createOwnedLockFile,
  withCredentialLock,
  withCredentialLockIfFree,
  withOwnedLockAsync,
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
  /** The pid a lock names, which comes before its token. */
  const owner = (lock: string): string => readFileSync(lock, 'utf8').trim().split(/\s+/)[0] ?? '';

  it('takes a free lock, names its holder in it, and releases it', () => {
    const lock = path.join(dir(), 'x.lock');
    const h = acquireOwnedLock(lock, { waitMs: 0, staleMs: 5_000 });
    expect(h.held).toBe(true);
    expect(owner(lock)).toBe(String(process.pid));
    h.release();
    expect(existsSync(lock)).toBe(false);
    h.release(); // idempotent
  });

  it('leaves, on release, a lock another process has taken over', () => {
    // A holder that ran past the longest hold can have its lock taken over;
    // removing the lock then would remove the new holder's.
    const lock = path.join(dir(), 'x.lock');
    const other = String(process.pid + 1);
    const h = acquireOwnedLock(lock, { waitMs: 0, staleMs: 5_000 });
    writeFileSync(lock, other, 'utf8');
    h.release();
    expect(owner(lock)).toBe(other);
  });

  it('leaves, on release, a lock another task of this same process has taken over', () => {
    // The pid is the same; which acquisition holds the lock now is kept in memory.
    const lock = path.join(dir(), 'x.lock');
    const first = acquireOwnedLock(lock, { waitMs: 0, staleMs: 5_000, maxHoldMs: 60_000 });
    minutesAgo(lock, 2); // past the longest hold, so it is taken over though its pid runs
    const second = acquireOwnedLock(lock, { waitMs: 0, staleMs: 5_000, maxHoldMs: 60_000 });
    expect(second.held).toBe(true);
    first.release();
    expect(existsSync(lock)).toBe(true);
    second.release();
    expect(existsSync(lock)).toBe(false);
  });

  it('takes over at once a lock naming this process that none of its acquisitions holds', () => {
    // A dead ccx left it, and Windows gave its pid to this process.
    const lock = path.join(dir(), 'x.lock');
    writeFileSync(lock, String(process.pid), 'utf8');
    const h = acquireOwnedLock(lock, { waitMs: 0, staleMs: 5_000, maxHoldMs: 60_000 * 11 });
    expect(h.held).toBe(true);
    h.release();
  });

  it('writes a bare pid, which an older ccx reads as the holder', () => {
    // ccx 2.6.7 and older read Number(content), and a pid with anything after it
    // reads as no holder, so a live repair would be taken over after a minute.
    const lock = path.join(dir(), 'x.lock');
    const h = acquireOwnedLock(lock, { waitMs: 0, staleMs: 5_000 });
    expect(Number(readFileSync(lock, 'utf8').trim())).toBe(process.pid);
    h.release();
  });

  it('leaves no lock, and holds none, when the pid cannot be written', () => {
    // A full disk: an empty lock names no holder and would never be released.
    const lock = path.join(dir(), 'x.lock');
    const h = acquireOwnedLock(lock, {
      waitMs: 0,
      staleMs: 5_000,
      create: (file, content) =>
        createOwnedLockFile(file, content, () => {
          throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        }),
    });
    expect(h.held).toBe(false);
    expect(existsSync(lock)).toBe(false);
  });

  it('removes, after a failed write, only the lock it made, not one put in its place meanwhile', () => {
    // Another process judged the half-made lock abandoned and made its own.
    const lock = path.join(dir(), 'x.lock');
    const h = acquireOwnedLock(lock, {
      waitMs: 0,
      staleMs: 5_000,
      create: (file, content) =>
        createOwnedLockFile(file, content, () => {
          renameSync(file, `${file}.moved`);
          writeFileSync(file, '4242', 'utf8');
          throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        }),
    });
    expect(h.held).toBe(false);
    expect(readFileSync(lock, 'utf8')).toBe('4242');
  });

  it('says why, and at once, when the lock cannot be made at all', () => {
    // Not somebody holding it: nobody can, so waiting would change nothing.
    const lock = path.join(dir(), 'x.lock');
    const started = Date.now();
    const h = acquireOwnedLock(lock, {
      waitMs: 10_000,
      staleMs: 5_000,
      platform: 'linux',
      create: () => {
        throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
      },
    });
    expect(h).toMatchObject({ held: false, unusable: 'EMFILE' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('leaves no lock, and holds none, when the pid is written only in part', () => {
    const lock = path.join(dir(), 'x.lock');
    const h = acquireOwnedLock(lock, {
      waitMs: 0,
      staleMs: 5_000,
      // Every byte but the last, as a short write leaves it.
      create: (file, content) => createOwnedLockFile(file, content, (fd, text) => writeSync(fd, text.slice(0, -1))),
    });
    expect(h.held).toBe(false);
    expect(existsSync(lock)).toBe(false);
  });

  it('leaves a lock just past half the longest hold, on release, when the takeover guard is held', () => {
    const lock = path.join(dir(), 'x.lock');
    const h = acquireOwnedLock(lock, { waitMs: 0, staleMs: 5_000, maxHoldMs: 60_000 });
    minutesAgo(lock, 31 / 60); // 31 seconds of a 60-second longest hold
    mkdirSync(`${lock}.takeover`);
    h.release();
    expect(existsSync(lock)).toBe(true);
  });

  it('leaves a lock held past the longest hold, on release, when the takeover guard is held', () => {
    // Whoever holds the guard is taking the lock over, and removing it
    // unguarded could remove the lock that takeover makes next.
    const lock = path.join(dir(), 'x.lock');
    const h = acquireOwnedLock(lock, { waitMs: 0, staleMs: 5_000, maxHoldMs: 60_000 });
    minutesAgo(lock, 2);
    mkdirSync(`${lock}.takeover`);
    h.release();
    expect(existsSync(lock)).toBe(true);
    expect(owner(lock)).toBe(String(process.pid));
  });

  it('removes a lock held past the longest hold, on release, under the takeover guard', () => {
    const lock = path.join(dir(), 'x.lock');
    const h = acquireOwnedLock(lock, { waitMs: 0, staleMs: 5_000, maxHoldMs: 60_000 });
    minutesAgo(lock, 2);
    h.release();
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.takeover`)).toBe(false);
  });

  it('removes a lock held briefly, on release, without the takeover guard, which no takeover can need yet', () => {
    const lock = path.join(dir(), 'x.lock');
    const h = acquireOwnedLock(lock, { waitMs: 0, staleMs: 5_000, maxHoldMs: 60_000 });
    mkdirSync(`${lock}.takeover`); // even one left behind does not hold it up
    h.release();
    expect(existsSync(lock)).toBe(false);
  });

  it('removes its own lock on release, and the takeover guard with it', () => {
    const lock = path.join(dir(), 'x.lock');
    const h = acquireOwnedLock(lock, { waitMs: 0, staleMs: 5_000 });
    h.release();
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.takeover`)).toBe(false);
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
    // Another process's pid, reported running, so only the age can let it go.
    const lock = path.join(dir(), 'x.lock');
    writeFileSync(lock, '4242', 'utf8');
    minutesAgo(lock, 2);
    const isRunning = (pid: number): boolean => pid === 4242;
    expect(acquireOwnedLock(lock, { waitMs: 0, staleMs: 5_000, maxHoldMs: 180_000, isRunning }).held).toBe(false);
    const h = acquireOwnedLock(lock, { waitMs: 0, staleMs: 5_000, maxHoldMs: 60_000, isRunning });
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
    const create = (file: string, content: string): void => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('delete pending'), { code: 'EPERM' });
      writeFileSync(file, content, { flag: 'wx' });
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

describe('withOwnedLockAsync', () => {
  const owner = (lock: string): string => readFileSync(lock, 'utf8').trim().split(/\s+/)[0] ?? '';
  const options = { waitMs: 5_000, staleMs: 5_000 };

  it('waits for a running holder with the thread free, and does the work once it lets go', async () => {
    // Held here, by a holder that lets go on a timer: only a wait that leaves
    // the thread free lets that timer run.
    const lock = path.join(dir(), 'x.lock');
    const holder = acquireOwnedLock(lock, { waitMs: 0, staleMs: 5_000 });
    expect(holder.held).toBe(true);
    let ticks = 0;
    const ticker = setInterval(() => (ticks += 1), 10);
    setTimeout(() => holder.release(), 300);
    try {
      const seen = await withOwnedLockAsync(lock, options, (h) => ({ held: h.held, owner: owner(lock) }));
      expect(seen).toEqual({ held: true, owner: String(process.pid) });
      expect(ticks).toBeGreaterThan(5);
    } finally {
      clearInterval(ticker);
      holder.release();
    }
    // Let go once the work was done.
    expect(existsSync(lock)).toBe(false);
  });

  it('hands the work the lock unheld once the wait runs out, and leaves the holder its lock', async () => {
    const lock = path.join(dir(), 'x.lock');
    const holder = acquireOwnedLock(lock, { waitMs: 0, staleMs: 5_000 });
    try {
      expect(await withOwnedLockAsync(lock, { ...options, waitMs: 150 }, (h) => h.held)).toBe(false);
      expect(owner(lock)).toBe(String(process.pid));
      expect(existsSync(lock)).toBe(true);
    } finally {
      holder.release();
    }
  });

  it('does the work before it returns when the lock is free', async () => {
    const lock = path.join(dir(), 'x.lock');
    let held: boolean | null = null;
    const done = withOwnedLockAsync(lock, options, (h) => {
      held = h.held;
      return 'done';
    });
    expect(held).toBe(true);
    expect(existsSync(lock)).toBe(false);
    expect(await done).toBe('done');
  });

  it('takes over at once the lock of a holder that has exited, by the same rules', async () => {
    const lock = path.join(dir(), 'x.lock');
    writeFileSync(lock, '4242', 'utf8');
    const isRunning = (pid: number): boolean => pid !== 4242;
    expect(await withOwnedLockAsync(lock, { ...options, isRunning }, (h) => h.held)).toBe(true);
  });

  it('takes over a running holder once its lock is older than the longest hold, while it waits', async () => {
    // Fresh when the wait begins: only waiting it out lets it go.
    const lock = path.join(dir(), 'x.lock');
    writeFileSync(lock, '4242', 'utf8');
    // Asked only of a lock younger than the longest hold.
    let asked = 0;
    const isRunning = (pid: number): boolean => {
      asked += 1;
      return pid === 4242;
    };
    const held = await withOwnedLockAsync(lock, { ...options, maxHoldMs: 300, isRunning }, (h) => h.held);
    expect(held).toBe(true);
    expect(asked).toBeGreaterThan(0);
  });

  it('lets go of the lock when the work throws, and fails with what it threw', async () => {
    const lock = path.join(dir(), 'x.lock');
    await expect(
      withOwnedLockAsync(lock, options, () => {
        throw new Error('the work failed');
      }),
    ).rejects.toThrow('the work failed');
    expect(existsSync(lock)).toBe(false);
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
