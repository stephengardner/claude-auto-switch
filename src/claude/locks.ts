import { mkdirSync, rmdirSync, statSync, utimesSync } from 'node:fs';
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

/**
 * Run `fn` while holding Claude's credential lock for `configDir` (best effort).
 * The lock is always released, including when `fn` throws.
 */
export function withCredentialLock<T>(configDir: string, fn: () => T, options: LockOptions = {}): T {
  const lock = acquireLockDir(path.join(configDir, CREDENTIALS_LOCK_DIR), options);
  try {
    return fn();
  } finally {
    lock.release();
  }
}
