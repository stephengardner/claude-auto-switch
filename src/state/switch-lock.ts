import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { configHome, type PathCtx } from '../config/paths.js';
import { acquireOwnedLock } from '../claude/locks.js';

/**
 * One switch of the active account at a time.
 *
 * A switch is three steps (which account is active, which sessions are asked to
 * move, the line in the history), and two of them interleaved leave the active
 * account saying one thing and the sessions told another. The watcher and a
 * hand-made `ccx use` both make their switch under this lock, and the watcher
 * looks again at which account is active once it holds it, so a pick made a
 * moment before is seen rather than overwritten.
 *
 * Held for milliseconds. A holder that died is taken over at once, since the
 * lock names its pid.
 */

const FILENAME = 'switch.lock';
/** A lock naming no holder is one being created; older than this, it was abandoned. */
const STALE_MS = 10_000;

export function switchLockPath(c: PathCtx = {}): string {
  return path.join(configHome(c), FILENAME);
}

export interface SwitchLockOptions {
  /** How long to wait for another switch to finish. Zero: do not wait. */
  waitMs: number;
  now?: () => number;
  /** Injected in tests: whether the process a lock names is still running. */
  isRunning?: (pid: number) => boolean;
}

/**
 * Run `fn` under the switch lock. `held` is false when the wait ran out with
 * another switch still going: the caller decides whether to go ahead anyway (a
 * person's own switch does) or leave it for later (the watcher does).
 */
export function withSwitchLock<T>(c: PathCtx, options: SwitchLockOptions, fn: (held: boolean) => T): T {
  const file = switchLockPath(c);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* the lock attempt below reports the folder as unusable */
  }
  const lock = acquireOwnedLock(file, {
    waitMs: options.waitMs,
    staleMs: STALE_MS,
    ...(options.now ? { now: options.now } : {}),
    ...(options.isRunning ? { isRunning: options.isRunning } : {}),
  });
  try {
    return fn(lock.held);
  } finally {
    lock.release();
  }
}
