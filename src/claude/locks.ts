import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

/**
 * Cooperate with Claude Code's OWN advisory lock while we swap credentials.
 *
 * Why: Claude refreshes its OAuth token in the background. It takes this lock,
 * reads the credential, decides it is near expiry, refreshes, and writes the
 * result back. A swap landing inside that window can be overwritten by the
 * refreshed OLD account's token. Holding the same lock for the few milliseconds
 * of our swap closes that window: Claude waits, and its post-lock re-read then
 * sees our fresh (non-expired) credential and skips its own refresh.
 *
 * The lock is a DIRECTORY (mkdir is atomic across processes), matching the
 * lockfile convention Claude uses: `<config dir>/.oauth_refresh.lock`.
 *
 * Deliberately BEST EFFORT with a bounded wait. Claude Code ships as a compiled
 * binary, so its exact staleness constants are not readable; guessing wrong and
 * blocking would turn a rare race into a guaranteed hang. If the lock cannot be
 * taken quickly we proceed anyway, which is exactly the (working) behavior we
 * had before this existed, only now the common case is properly serialized.
 */

export const CREDENTIALS_LOCK_DIR = '.oauth_refresh.lock';

export interface LockOptions {
  /** Give up waiting after this long and proceed unlocked. */
  waitMs?: number;
  /** Only take over a lock whose mtime is older than this (assume abandoned). */
  staleMs?: number;
  /** Refresh our own lock's mtime this often so others do not judge it stale. */
  touchMs?: number;
  now?: () => number;
}

export interface LockHandle {
  /** True when we actually hold the lock (false = proceeding without it). */
  held: boolean;
  release(): void;
}

const DEFAULTS = { waitMs: 2000, staleMs: 60_000, touchMs: 3000 };

/** Block the current thread briefly without spinning the CPU. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function mtimeMs(dir: string): number | null {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Try to take the lock directory. Returns a handle that is `held: false` when
 * the wait elapsed; callers proceed either way and must always release().
 */
export function acquireLockDir(lockDir: string, options: LockOptions = {}): LockHandle {
  const waitMs = options.waitMs ?? DEFAULTS.waitMs;
  const staleMs = options.staleMs ?? DEFAULTS.staleMs;
  const touchMs = options.touchMs ?? DEFAULTS.touchMs;
  const now = options.now ?? (() => Date.now());
  const deadline = now() + waitMs;

  let held = false;
  for (;;) {
    try {
      mkdirSync(lockDir, { recursive: false });
      held = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') break; // unusable path: proceed
      const age = mtimeMs(lockDir);
      if (age !== null && now() - age > staleMs) {
        // Abandoned by a dead process: take it over rather than waiting forever.
        try {
          rmdirSync(lockDir);
          continue;
        } catch {
          /* someone else won the takeover; fall through to waiting */
        }
      }
      if (now() >= deadline) break; // bounded: never hang the operator's swap
      sleepSync(50);
    }
  }

  if (!held) return { held: false, release: () => {} };

  // Keep the lock looking alive while we hold it. Unref'd so this timer can
  // never keep the CLI process running (a hang we have been bitten by before).
  const timer = setInterval(() => {
    try {
      const t = new Date();
      utimesSync(lockDir, t, t);
    } catch {
      /* lock vanished; release() will no-op */
    }
  }, touchMs);
  timer.unref?.();

  let released = false;
  return {
    held: true,
    release: () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      try {
        rmdirSync(lockDir);
      } catch {
        /* already gone */
      }
    },
  };
}

export interface OwnedLockOptions {
  /** Give up waiting for a running holder after this long, and proceed unheld. */
  waitMs: number;
  /** A lock that names no holder is taken over once it is this old. */
  staleMs: number;
  /** A running holder's lock is taken over past this age all the same: its pid may be another process's by now. */
  maxHoldMs?: number;
  now?: () => number;
  isRunning?: (pid: number) => boolean;
  /** Creates the lock file, failing if it exists, and names this process in it. */
  create?: (file: string) => void;
  platform?: NodeJS.Platform;
}

/**
 * A lock for work done synchronously, which therefore cannot refresh its lock
 * while it works: the lock's age says nothing about whether its holder is still
 * at it. The lock is a file naming the holder's pid, and is taken over when that
 * process has exited, never because it is old. A lock that names no holder (one
 * being created, or one an older build made as a directory) is judged by age.
 *
 * A takeover judges the lock again under a guard of its own, so two processes
 * that both found it abandoned cannot each remove it, the second taking away the
 * lock the first had just made.
 */
export function acquireOwnedLock(lockFile: string, options: OwnedLockOptions): LockHandle {
  const now = options.now ?? (() => Date.now());
  const create = options.create ?? createOwnedLockFile;
  // How Windows refuses a new file while the last one is still being removed.
  const busy = (options.platform ?? process.platform) === 'win32' ? ['EEXIST', 'EPERM', 'EACCES', 'EBUSY'] : ['EEXIST'];
  const deadline = now() + options.waitMs;
  const abandoned = (): boolean =>
    isAbandoned(lockFile, now(), options.staleMs, options.maxHoldMs ?? 60_000, options.isRunning ?? isRunning);

  for (;;) {
    try {
      create(lockFile);
      return ownedHandle(lockFile);
    } catch (err) {
      if (!busy.includes((err as NodeJS.ErrnoException).code ?? '')) return { held: false, release: () => {} };
    }
    if (abandoned() && takeOver(lockFile, abandoned, now(), options.staleMs)) continue;
    if (now() >= deadline) return { held: false, release: () => {} };
    sleepSync(50);
  }
}

function createOwnedLockFile(file: string): void {
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeSync(fd, String(process.pid));
  } catch {
    /* held all the same; with no holder named it is judged by its age */
  } finally {
    closeSync(fd);
  }
}

function ownedHandle(lockFile: string): LockHandle {
  let released = false;
  return {
    held: true,
    release: () => {
      if (released) return;
      released = true;
      try {
        rmSync(lockFile, { force: true });
      } catch {
        /* already gone */
      }
    },
  };
}

function isAbandoned(
  lockFile: string,
  now: number,
  staleMs: number,
  maxHoldMs: number,
  running: (pid: number) => boolean,
): boolean {
  const since = mtimeMs(lockFile);
  if (since === null) return false; // gone: the next attempt takes it
  const age = now - since;
  const holder = lockHolder(lockFile);
  if (holder === null) return age > staleMs;
  return age > maxHoldMs || !running(holder);
}

function lockHolder(lockFile: string): number | null {
  try {
    const pid = Number(readFileSync(lockFile, 'utf8').trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null; // a directory from an older build, or unreadable
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // running, as someone else
  }
}

/** True when it removed the abandoned lock. */
function takeOver(lockFile: string, stillAbandoned: () => boolean, now: number, staleMs: number): boolean {
  const guard = `${lockFile}.takeover`;
  try {
    mkdirSync(guard);
  } catch {
    // Another process is taking it over. A guard left by one that died while
    // doing so is cleared, for the next attempt.
    const since = mtimeMs(guard);
    if (since !== null && now - since > staleMs) {
      try {
        rmdirSync(guard);
      } catch {
        /* someone else cleared it */
      }
    }
    return false;
  }
  try {
    if (!stillAbandoned()) return false;
    rmSync(lockFile, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmdirSync(guard);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run `fn` while holding Claude's credential lock for `configDir` (best effort).
 * The lock is always released, including when `fn` throws.
 */
/**
 * Run `fn` under the credential lock, but ONLY if the lock is free right now.
 * Returns false, without running `fn`, when something else holds it.
 *
 * For opportunistic work that runs on a timer. The wait inside acquireLockDir is
 * a synchronous sleep loop (up to two seconds by default), so waiting there from
 * a timer would stall whatever loop is driving it: on the session's poll that
 * means freezing the terminal relay. Skipping and trying again on the next tick
 * costs nothing.
 */
export function withCredentialLockIfFree(configDir: string, fn: () => void): boolean {
  const lock = acquireLockDir(path.join(configDir, CREDENTIALS_LOCK_DIR), { waitMs: 0 });
  if (!lock.held) return false;
  try {
    fn();
  } finally {
    lock.release();
  }
  return true;
}

export function withCredentialLock<T>(configDir: string, fn: () => T, options: LockOptions = {}): T {
  const lock = acquireLockDir(path.join(configDir, CREDENTIALS_LOCK_DIR), options);
  try {
    return fn();
  } finally {
    lock.release();
  }
}
