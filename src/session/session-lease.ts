import path from 'node:path';
import { liveLeases, type LeaseOptions, type SessionLease } from './lease.js';
import type { PathCtx } from '../config/paths.js';

/** Two spellings of one folder: separators, a trailing one, `..`, and case on the systems that ignore it. */
export function sameFolder(a: string, b: string): boolean {
  const fold = (p: string): string => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  return fold(a) === fold(b);
}

/**
 * The live announcement naming `configDir` as the folder its session reads
 * its login from, or null when no running ccx session uses that folder.
 *
 * Anything Claude runs for a session (its status line, a hook) inherits that
 * session's `CLAUDE_CONFIG_DIR`, so this is how such a program learns which
 * account its own session is on, and that ccx runs it at all. With two
 * announcements for one folder, the newer: a move announces the account it
 * moves onto before it gives up the old one.
 */
export function sessionLease(configDir: string, c: PathCtx = {}, options: LeaseOptions = {}): SessionLease | null {
  // Oldest first, so the last match is the newest.
  const mine = liveLeases(c, options).filter(
    (lease) => typeof lease.configDir === 'string' && sameFolder(lease.configDir, configDir),
  );
  return mine[mine.length - 1] ?? null;
}
