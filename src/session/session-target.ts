import type { SessionLease } from './lease.js';

/**
 * Which running session a switch should be aimed at.
 *
 * `ccx use` can move one specific session instead of broadcasting to all of
 * them. This resolves the operator's choice against the live sessions, and is
 * pure so the (fiddly) ambiguity rules are tested without real processes.
 */
export interface TargetQuery {
  /** An explicit ccx-run pid (`--session <pid>`). */
  session?: number;
  /** Target the session running in `cwd` (`--here`). */
  here?: boolean;
  /** The working directory to match for `--here`; defaults to the caller's cwd. */
  cwd?: string;
}

export type TargetResolution =
  | { kind: 'broadcast' }
  | { kind: 'session'; pid: number; lease: SessionLease }
  | { kind: 'error'; message: string };

function normalizeDir(p: string): string {
  const forward = p.split('\\').join('/').replace(/\/+$/, '');
  return process.platform === 'win32' ? forward.toLowerCase() : forward;
}

/** Describe a session compactly for a chooser message: "12345 (acct in C:/x)". */
export function describeLease(l: SessionLease): string {
  return l.cwd ? `${l.pid} (${l.account} in ${l.cwd})` : `${l.pid} (${l.account})`;
}

/**
 * Resolve a target from the live leases. No query -> broadcast (the historical
 * `ccx use` behaviour). `--session` must match a live session. `--here` matches
 * by working directory, and is an error when nothing (or more than one thing)
 * matches, so a switch never silently lands on the wrong session.
 */
export function resolveTarget(leases: SessionLease[], query: TargetQuery): TargetResolution {
  if (query.session !== undefined) {
    const lease = leases.find((l) => l.pid === query.session);
    if (!lease) {
      const live = leases.length
        ? `live sessions: ${leases.map(describeLease).join(', ')}`
        : 'no sessions are running';
      return { kind: 'error', message: `no live ccx session with pid ${query.session} (${live})` };
    }
    return { kind: 'session', pid: lease.pid, lease };
  }

  if (query.here) {
    const cwd = query.cwd;
    if (!cwd) return { kind: 'error', message: 'could not read the current directory for --here' };
    const target = normalizeDir(cwd);
    const matches = leases.filter((l) => l.cwd && normalizeDir(l.cwd) === target);
    if (matches.length === 0) {
      return {
        kind: 'error',
        message:
          `no live ccx session is running in ${cwd}` +
          (leases.length ? `; try --session <pid> (${leases.map(describeLease).join(', ')})` : ''),
      };
    }
    if (matches.length > 1) {
      return {
        kind: 'error',
        message:
          `more than one session is running in ${cwd}; pick one with --session <pid>: ` +
          matches.map(describeLease).join(', '),
      };
    }
    return { kind: 'session', pid: matches[0]!.pid, lease: matches[0]! };
  }

  return { kind: 'broadcast' };
}
