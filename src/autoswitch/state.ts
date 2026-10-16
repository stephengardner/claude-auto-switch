import path from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { configHome, type PathCtx } from '../config/paths.js';
import { readJsonFile, writeJsonFile } from '../util/fs-json.js';

/**
 * What the auto-switch watcher remembers between passes, and the two files
 * that hold it back.
 *
 * Each pass is a fresh process as often as not (a service loop, cron, the
 * watchdog on another machine running one), so everything a decision needs
 * that one reading cannot give lives here: the last few readings of the
 * account in use, when it became the one in use, and what was already tried.
 */

const ReadingSchema = z.object({
  used: z.number(),
  wide: z.number(),
  carried: z.boolean().optional(),
  at: z.number(),
});

const StateSchema = z.object({
  /** The account the readings are about, and since when it has been the one in use. */
  account: z.object({ name: z.string(), since: z.number() }).nullable().default(null),
  /** The watcher's own readings of that account, oldest first. */
  reads: z.array(ReadingSchema).default([]),
  lastReadAt: z.number().default(0),
  lastOkAt: z.number().default(0),
  /** No read before this: the endpoint asked for a pause, or a switch has just landed. */
  holdReadsUntil: z.number().default(0),
  lastFailure: z.object({ at: z.number(), status: z.union([z.number(), z.string()]) }).nullable().default(null),
  /** Reads the login itself was refused on, since the last one that answered. */
  refusals: z.object({ count: z.number(), first: z.number(), last: z.number() }).nullable().default(null),
  /** The last pass that found no account with room. */
  none: z
    .object({ at: z.number(), until: z.number().nullable(), loose: z.boolean() })
    .nullable()
    .default(null),
  /** Targets a fresh read found too full to move to, until when. */
  full: z.record(z.string(), z.object({ until: z.number(), loose: z.boolean() })).default({}),
  /** Targets a move failed on, until when. */
  failed: z.record(z.string(), z.number()).default({}),
  /** The last move made off a refused or unreadable login, whatever moves came after it. */
  lastRiskyAt: z.number().nullable().default(null),
  /** Machines that did not follow the last switch yet and may still: asked again for a while. */
  follow: z
    .object({
      from: z.string(),
      to: z.string(),
      kind: z.string(),
      hosts: z.array(z.string()),
      until: z.number(),
      lastAt: z.number(),
    })
    .nullable()
    .default(null),
  lastSwitch: z
    .object({
      at: z.number(),
      from: z.string(),
      to: z.string(),
      kind: z.string(),
      why: z.string(),
      by: z.string(),
    })
    .nullable()
    .default(null),
  /** The last decision in words, and its category: a line is logged when the category changes. */
  lastWhy: z.string().nullable().default(null),
  lastCat: z.string().nullable().default(null),
  lastPassAt: z.number().default(0),
  lastPassBy: z.string().nullable().default(null),
  /** Usage reads per hour, kind and status (see countRead). */
  counts: z.record(z.string(), z.record(z.string(), z.number())).default({}),
});

export type WatchState = z.infer<typeof StateSchema>;

export function emptyState(): WatchState {
  return StateSchema.parse({});
}

/** Where the watcher keeps its files, inside the config home. */
export function watchDir(c: PathCtx = {}): string {
  return path.join(configHome(c), 'autoswitch');
}

const file = (c: PathCtx, name: string): string => path.join(watchDir(c), name);

export const statePath = (c: PathCtx = {}): string => file(c, 'state.json');
/** Written at the start of each pass the service runs; another machine reads its age. */
export const heartbeatPath = (c: PathCtx = {}): string => file(c, 'heartbeat');
export const passLockPath = (c: PathCtx = {}): string => file(c, 'pass.lock');
const pausedPath = (c: PathCtx): string => file(c, 'paused');
const earlyOffPath = (c: PathCtx): string => file(c, 'early-off');

/**
 * The state as last saved. A file that is missing, damaged or from a build
 * with another shape reads as empty: the next pass rebuilds what it needs,
 * and a watcher that will not start over a bad file protects nothing.
 */
export function loadState(c: PathCtx = {}): WatchState {
  try {
    return readJsonFile(statePath(c), StateSchema) ?? emptyState();
  } catch {
    return emptyState();
  }
}

/** Best effort: a pass that cannot save still made its decision. */
export function saveState(state: WatchState, c: PathCtx = {}): void {
  try {
    writeJsonFile(statePath(c), state);
  } catch {
    /* the next pass rebuilds what it needs */
  }
}

/** What holds the watcher back, as set by hand. */
export interface Controls {
  /** No move of any kind, with the reason given; null when not paused. */
  paused: string | null;
  /** Early moves are held; an account that cannot run still moves. */
  earlyOff: boolean;
}

function readLine(target: string): string | null {
  try {
    return readFileSync(target, 'utf8').trim();
  } catch {
    return null;
  }
}

export function readControls(c: PathCtx = {}): Controls {
  const paused = readLine(pausedPath(c));
  return { paused: paused === null ? null : paused || 'no reason given', earlyOff: readLine(earlyOffPath(c)) !== null };
}

function writeMark(target: string, text: string): void {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, `${text}\n`, { mode: 0o600 });
}

/** Stop every move until `resume`. The watcher keeps reading and logging what it would have done. */
export function pause(reason: string, c: PathCtx = {}): void {
  writeMark(pausedPath(c), reason);
}

/** Hold early moves, or let them go again. */
export function setEarlyMoves(on: boolean, c: PathCtx = {}, by = ''): void {
  if (on) rmSync(earlyOffPath(c), { force: true });
  else writeMark(earlyOffPath(c), by);
}

/** Back to moving by itself: clears the pause and turns early moves on, whichever was set. */
export function resume(c: PathCtx = {}): void {
  rmSync(pausedPath(c), { force: true });
  rmSync(earlyOffPath(c), { force: true });
}

/** Mark that a service pass has started. Best effort. */
export function beat(c: PathCtx = {}, now: number = Date.now()): void {
  try {
    writeMark(heartbeatPath(c), String(now));
  } catch {
    /* a missed beat reads as a late one, which is what it is */
  }
}

/** When the service last started a pass, or null when it never has. */
export function lastBeat(c: PathCtx = {}): number | null {
  const at = Number(readLine(heartbeatPath(c)));
  return Number.isFinite(at) && at > 0 ? at : null;
}
