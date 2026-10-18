import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
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
  /**
   * Set when the lock could not be created at all (its error code, as EACCES
   * or EMFILE), so nobody can hold it: not the same as somebody holding it now.
   */
  unusable?: string;
  release(): void;
}

const DEFAULTS = { waitMs: 2000, staleMs: 60_000, touchMs: 3000 };

/** Block the current thread briefly without spinning the CPU. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A lock's rules for taking it, as a series of tries: each step yields how
 * long to pause before the next try, and the last returns the outcome. Written
 * once, and run two ways: blocking the thread between tries, for a command
 * with nothing else to do, or on a timer, for a session, whose thread relays
 * Claude's terminal and the keys typed into it.
 */
type Tries<T> = Generator<number, T, void>;

function runBlocking<T>(tries: Tries<T>): T {
  for (let step = tries.next(); ; step = tries.next()) {
    if (step.done) return step.value;
    sleepSync(step.value);
  }
}

/**
 * `then` is given the outcome in the same step as the try that settled it, so
 * nothing else in this process runs in between. The first try is made before
 * this returns. The pauses are unref'd, so a wait never keeps a process alive
 * by itself: one that ends meanwhile never hears the outcome.
 */
async function runOnTimers<T, R>(tries: Tries<T>, then: (outcome: T) => R): Promise<R> {
  for (let step = tries.next(); ; step = tries.next()) {
    if (step.done) return then(step.value);
    const ms = step.value;
    await new Promise<void>((resolve) => setTimeout(resolve, ms).unref());
  }
}

function mtimeMs(dir: string): number | null {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Whether a lock directory is held now: it exists, and was touched within
 * `freshMs` (by default as long as acquireLockDir takes a lock to be). Only
 * looks, so it is cheap enough to ask again and again while waiting.
 */
export function lockDirHeld(lockDir: string, freshMs: number = DEFAULTS.staleMs, now: number = Date.now()): boolean {
  const touched = mtimeMs(lockDir);
  return touched !== null && now - touched <= freshMs;
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
  let unusable: string | undefined;
  for (;;) {
    try {
      mkdirSync(lockDir, { recursive: false });
      held = true;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        unusable = code ?? 'unknown error';
        break; // unusable path: proceed
      }
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

  if (!held) return { held: false, ...(unusable ? { unusable } : {}), release: () => {} };

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
  /** Creates the lock file, failing if it exists, with `content` in it: this process's pid. */
  create?: (file: string, content: string) => void;
  platform?: NodeJS.Platform;
}

/**
 * Which acquisition in this process holds each lock file now. Other processes
 * are told apart by the pid in the file, since no two live processes share
 * one; acquisitions inside this process share the pid, so this tells them
 * apart, and a takeover by this same process replaces the entry. This holds
 * while one copy of this module serves the whole process, with no worker
 * threads taking locks, as in ccx today.
 */
const heldHere = new Map<string, symbol>();

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
  return runBlocking(ownedLockTries(lockFile, options));
}

/**
 * acquireOwnedLock without blocking, for a session, which must go on relaying
 * while it waits: the same rules, with the thread free between tries. `work`
 * is handed the lock as acquireOwnedLock would hand it back (held, or the wait
 * run out), runs at once, before anything else in this process can, and the
 * lock is let go as it returns, so it must be synchronous. As with
 * acquireOwnedLock, nothing else in this process runs while the lock is held.
 */
export function withOwnedLockAsync<T>(
  lockFile: string,
  options: OwnedLockOptions,
  work: (lock: LockHandle) => T,
): Promise<T> {
  return runOnTimers(ownedLockTries(lockFile, options), (lock) => {
    try {
      return work(lock);
    } finally {
      lock.release();
    }
  });
}

function* ownedLockTries(lockFile: string, options: OwnedLockOptions): Tries<LockHandle> {
  const now = options.now ?? (() => Date.now());
  const create = options.create ?? createOwnedLockFile;
  // How Windows refuses a new file while the last one is still being removed.
  const busy = (options.platform ?? process.platform) === 'win32' ? ['EEXIST', 'EPERM', 'EACCES', 'EBUSY'] : ['EEXIST'];
  const deadline = now() + options.waitMs;
  const abandoned = (): boolean =>
    isAbandoned(lockFile, now(), options.staleMs, options.maxHoldMs ?? 60_000, options.isRunning ?? isRunning);

  for (;;) {
    try {
      // A bare pid, which every build of ccx reads, older ones included.
      create(lockFile, String(process.pid));
      const token = Symbol(lockFile);
      heldHere.set(path.resolve(lockFile), token);
      return ownedHandle(lockFile, token, options.maxHoldMs ?? 60_000, now);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!busy.includes(code)) return { held: false, unusable: code || 'unknown error', release: () => {} };
    }
    if (abandoned() && takeOver(lockFile, abandoned, now(), options.staleMs)) continue;
    if (now() >= deadline) return { held: false, release: () => {} };
    yield 50;
  }
}

/**
 * Create the lock file with the holder's pid in it. A lock whose pid could not
 * be written (a full disk) is removed again and refused: one naming no holder
 * would hold everyone else off until it went stale, and never be released.
 */
export function createOwnedLockFile(
  file: string,
  content: string,
  write: (fd: number, text: string) => unknown = (fd, text) => writeFileSync(fd, text),
): void {
  const fd = openSync(file, 'wx', 0o600);
  let written = false;
  try {
    write(fd, content);
    // Read back, since a write can come up short and a lock without its whole
    // pid names no holder.
    if (readFileSync(file, 'utf8') !== content) {
      throw Object.assign(new Error(`could not write all of ${file}`), { code: 'EIO' });
    }
    written = true;
  } finally {
    try {
      if (!written) removeOwnFailedLock(file, fd);
    } finally {
      closeSync(fd);
    }
  }
}

/**
 * Remove a lock this attempt created but could not finish, and only that one:
 * compared with the open file, which keeps its identity from being reused,
 * and under the takeover guard, so no takeover replaces it between the look
 * and the removal. Without the guard it is left, since whoever holds the
 * guard is taking it over.
 */
function removeOwnFailedLock(file: string, fd: number): void {
  const guard = `${file}.takeover`;
  if (!takeGuard(guard)) return;
  try {
    const opened = fstatSync(fd, { bigint: true });
    const current = statSync(file, { bigint: true });
    if (opened.dev === current.dev && opened.ino === current.ino) rmSync(file, { force: true });
  } catch {
    /* already gone */
  } finally {
    try {
      rmdirSync(guard);
    } catch {
      /* already gone */
    }
  }
}

/**
 * The one rule by which a running holder's lock may be taken over: once it is
 * older than the longest hold.
 */
function pastLongestHold(age: number, maxHoldMs: number): boolean {
  return age > maxHoldMs;
}

function ownedHandle(lockFile: string, token: symbol, maxHoldMs: number, now: () => number): LockHandle {
  let released = false;
  return {
    held: true,
    release: () => {
      if (released) return;
      released = true;
      // Only while the lock is still this acquisition's: a holder that ran past
      // the longest hold may have been taken over, by another task of this
      // process (which replaced it in heldHere) or by another process (whose
      // pid is in the file now), and the lock is then the new holder's.
      const key = path.resolve(lockFile);
      if (heldHere.get(key) !== token) return;
      heldHere.delete(key);
      // A running holder's lock is taken over only once it is older than the
      // longest hold, so while it is younger than half of that, a takeover
      // practically cannot replace it between the look and the removal, short
      // of this process pausing for at least half the longest hold in between
      // (30 seconds for an event, five and a half minutes for a repair). Past
      // that, both happen under the takeover guard, and the lock is left when
      // the guard cannot be had, since whoever holds it is taking it over.
      // Short holds, as every event's is, never pay for the guard.
      const since = mtimeMs(lockFile);
      const young = since !== null && now() - since < maxHoldMs / 2;
      const guard = `${lockFile}.takeover`;
      const guarded = !young && takeGuard(guard);
      if (!young && !guarded) return;
      try {
        if (lockHolder(lockFile) === process.pid) rmSync(lockFile, { force: true });
      } catch {
        /* already gone */
      } finally {
        if (guarded) {
          try {
            rmdirSync(guard);
          } catch {
            /* already gone */
          }
        }
      }
    },
  };
}

/**
 * Take the takeover guard, trying for about half a second: a takeover holds it
 * for a few file operations, and Windows refuses a new folder for a moment
 * while the last one of that name is still being removed.
 */
function takeGuard(guard: string): boolean {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      mkdirSync(guard);
      return true;
    } catch {
      sleepSync(25);
    }
  }
  return false;
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
  // This process's own pid with no acquisition of this process holding the
  // lock: a dead ccx left it, and Windows has given its pid to this process.
  if (holder === process.pid && !heldHere.has(path.resolve(lockFile))) return true;
  return pastLongestHold(age, maxHoldMs) || !running(holder);
}

function lockHolder(lockFile: string): number | null {
  try {
    // The pid comes first; older builds wrote it alone.
    const pid = Number(readFileSync(lockFile, 'utf8').trim().split(/\s+/)[0]);
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
