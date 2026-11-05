import { spawnSync } from 'node:child_process';
import { locksHeldHere } from '../claude/locks.js';
import { loadConfig } from '../config/config.js';
import { configHome } from '../config/paths.js';
import { appendEvent, flushQueuedEvents } from '../events/log.js';
import { flushPendingLedgerChanges } from '../ledger/ledger.js';
import { newerInstall, type NewerInstall } from './newer-install.js';
import type { CliContext } from '../context.js';

/**
 * A ccx that keeps running (the dashboard, `ccx auto`, `ccx daemon run`) goes
 * on running the code it started with, so a fix installed meanwhile does not
 * reach it: a dashboard left open for 13 days renewed logins through a save
 * already fixed, and cut eight of them short (issue #186). Each now moves to
 * a newer ccx as a session does (session.ts), at a moment it holds nothing,
 * and until it can, renews and saves no logins.
 */

/**
 * The newer ccx to move to now, or null: none is ready to start
 * (newerInstall), or `update.follow` is off. The setting is read from the file
 * each time, so turning it off reaches a ccx that is already running.
 */
export function newerToFollow(context: CliContext): NewerInstall | null {
  let follow = context.config.update.follow;
  try {
    follow = loadConfig(context.ctx).update.follow;
  } catch {
    /* a settings file that will not load: the setting this ccx started with */
  }
  return follow ? (context.newerInstall ?? newerInstall)() : null;
}

/**
 * Whether this process holds no lock now, so another ccx started now waits on
 * nothing of this one's. Work that holds one (a move of the editor's login, a
 * renewal) finishes first.
 */
export function holdsNothing(): boolean {
  return locksHeldHere() === 0;
}

/**
 * Start `newer` in this ccx's place with `args`, in this terminal, wait for it,
 * and end with its exit status. `what` names this ccx in the event log.
 */
export function handOver(context: CliContext, newer: NewerInstall, args: string[], what: string): number {
  announceHandover(context, newer, args, what);
  // Holds this thread until the newer ccx ends, which may be days.
  const result = spawnSync(process.execPath, [newer.cli, ...args], { stdio: 'inherit' });
  if (result.error) {
    (context.err ?? context.out)(`ccx: could not start ccx ${newer.version} (${result.error.message}); start ${what} again`);
  }
  return endAfterHandover(context, result.error ? 1 : (result.status ?? 1));
}

/** Say that `what` moves to `newer`, and write what is waiting to be written: nothing more runs here. */
export function announceHandover(context: CliContext, newer: NewerInstall, args: string[], what: string): void {
  appendEvent(configHome(context.ctx), `${what} moved to ccx ${newer.version}, installed while it ran`, Date.now(), {
    kind: 'update',
    data: { to: newer.version, command: args.find((a) => !a.startsWith('-')) ?? null },
  });
  flushPendingLedgerChanges();
  flushQueuedEvents();
}

/**
 * End this process once the newer ccx has taken over, so work this one left
 * waiting (a timer, a retry) never resumes on the old code.
 */
export function endAfterHandover(context: CliContext, code: number): number {
  (context.endAfterHandover ?? ((c: number) => process.exit(c)))(code);
  return code;
}
