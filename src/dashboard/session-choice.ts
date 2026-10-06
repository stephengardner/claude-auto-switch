import path from 'node:path';
import type { SessionLease } from '../session/lease.js';
import type { DashboardSession } from './render.js';

/**
 * Which running session a dashboard move is for.
 *
 * Every session moves on its own when its turn is refused; nothing moves them
 * all. Enter and f in the dashboard used to post one shared request that
 * whichever session looked first took, so with two sessions running, which
 * one moved was a coin flip, and a session already on that account could take
 * the request and drop it. Now a move names its sessions, through the same
 * per-session request `ccx use --session` writes. Pure, so the numbering and
 * the reading of an answer are testable without a terminal.
 */

/** A running session as the dashboard numbers it, with the pid a move is sent to. */
export interface NumberedSession extends DashboardSession {
  pid: number;
}

/**
 * Lease files are data on disk, and these are drawn on the operator's
 * terminal: control characters are stripped so a value cannot move the cursor
 * (CWE-150), as `ccx sessions` does.
 */
const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

/**
 * The running sessions, one per process, numbered 1, 2, ... by pid, which does
 * not change while they run, so a number means the same session from one
 * frame to the next. Each is named by its folder; two in one folder are told
 * apart by pid.
 */
export function numberSessions(leases: readonly SessionLease[]): NumberedSession[] {
  // Leases come oldest first, so the freshest one of each process wins: a
  // session that moved can briefly hold one for each account.
  const byPid = new Map<number, SessionLease>();
  for (const lease of leases) byPid.set(lease.pid, lease);
  const live = [...byPid.values()].sort((a, b) => a.pid - b.pid);
  const folder = (l: SessionLease): string => (l.cwd ? clean(path.basename(l.cwd)) || String(l.pid) : String(l.pid));
  const taken = new Map<string, number>();
  for (const l of live) taken.set(folder(l), (taken.get(folder(l)) ?? 0) + 1);
  return live.map((l, i) => {
    const where = folder(l);
    return {
      number: i + 1,
      pid: l.pid,
      account: clean(l.account),
      where: (taken.get(where) ?? 0) > 1 && where !== String(l.pid) ? `${where} (${l.pid})` : where,
    };
  });
}

/**
 * The sessions an answer names: their numbers, in any order and separated any
 * way, or `a` (or `all`) for every one. An empty answer names none, which
 * still makes the account the one new sessions start on. Throws with the
 * reason for anything else, so the box can stay open to fix it.
 */
export function parseSessionChoice(answer: string, sessions: readonly NumberedSession[]): NumberedSession[] {
  const typed = answer.trim().toLowerCase();
  if (typed === '') return [];
  if (typed === 'a' || typed === 'all') return [...sessions];
  const picked: NumberedSession[] = [];
  for (const part of typed.split(/[\s,]+/).filter(Boolean)) {
    const n = Number(part);
    const session = Number.isInteger(n) ? sessions.find((s) => s.number === n) : undefined;
    if (!session) throw new Error(`"${part}" is not one of the sessions: 1 to ${sessions.length}, or a for all`);
    if (!picked.includes(session)) picked.push(session);
  }
  return picked;
}

/** The question Enter and f ask when more than one session is running. */
export function sessionQuestion(account: string, sessions: readonly NumberedSession[]): string {
  const listed = sessions.map((s) => `${s.number} ${s.where} (on ${s.account})`).join(', ');
  return `move which to "${account}"? ${listed}; a for all; enter alone for none:`;
}
