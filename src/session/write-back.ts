import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { acquireLockDir, type LockHandle } from '../claude/locks.js';
import { appendEvent } from '../events/log.js';
import { configHome } from '../config/paths.js';
import { defaultClaudeJsonPath } from '../daemon/reference-config.js';
import { keepOursOver } from '../statusline/settings-install.js';
import { isOurs } from '../statusline/ours.js';
import { writeFileAtomic } from '../util/atomic-write.js';
import { copyUserSettings, defaultClaudeRoot, rescue } from './shared-root.js';
import type { PathCtx } from '../config/paths.js';

/**
 * What a session changed in its own settings and in Claude's own state, handed
 * back to the user's real files, so a ccx session leaves things the way plain
 * `claude` would have.
 *
 * A ccx session runs Claude on a config folder of its own so its login can be
 * swapped in place, and that folder has its own settings.json and .claude.json.
 * What Claude wrote there (a model picked with /model, a permission allowed for
 * good, an MCP server added, a folder trusted, a preference changed) used to
 * stay there, and was gone with the folder. Both files are remembered as the
 * session set them up, and what the session changed since is written into the
 * user's own file, unless the user changed that same thing meanwhile, which
 * wins, or removed it, which it stays.
 */

const SETTINGS_BASE = '.ccx-base.settings.json';
const STATE_BASE = '.ccx-base.claude.json';

/**
 * Lists that are sets wherever they appear: what a session added or removed is
 * carried, never the whole list, so two sessions adding to one list both land.
 * Permission rules in settings; a folder's allowed tools and MCP choices in
 * Claude's state. Hooks (settings `hooks.<event>`) are sets too: see isSetList.
 */
const SET_LISTS = new Set([
  'allow',
  'deny',
  'ask',
  'additionalDirectories',
  'allowedTools',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'disabledMcpServers',
  'mcpContextUris',
]);

/** Preferences set through Claude itself, at the top of its state. */
const STATE_PREFS = [
  'theme',
  'editorMode',
  'verbose',
  'autoUpdates',
  'preferredNotifChannel',
  'autoCompactEnabled',
  'autoConnectIde',
  'diffTool',
];

/**
 * What of a folder's record in Claude's state is the user's choice. The rest is
 * Claude's bookkeeping about the last conversation there (its cost, duration,
 * tokens), which changes on every run and is nobody's decision: carrying it
 * would rewrite the user's state file at every relaunch for nothing.
 */
const PROJECT_CHOICES = [
  'allowedTools',
  'mcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'disabledMcpServers',
  'mcpContextUris',
  'hasTrustDialogAccepted',
  'hasClaudeMdExternalIncludesApproved',
  'hasClaudeMdExternalIncludesWarningShown',
];

/**
 * A folder an older ccx left has no record of how its session started. What it
 * holds is a full copy of the user's files as they were then, plus ccx's own
 * stamps (the folder marked trusted, its status line), so comparing it with the
 * user's files now would bring back whatever the user removed since and turn
 * ccx's stamps into the user's choices. Only its model goes back, and only
 * where the user's settings name none: all ccx used to keep from such a folder.
 */
const LEGACY_SETTINGS = ['model'];

type Json = Record<string, unknown>;

function readObject(file: string): Json | null {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Json)
      : null;
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const pick = (from: Json, keys: readonly string[]): Json =>
  Object.fromEntries(keys.filter((key) => key in from).map((key) => [key, from[key]]));

/**
 * The session's file as it starts, or an empty one when it has none yet:
 * "nothing" is a start too, and everything the session then writes is its
 * change. Without either, the folder is handed back as an older ccx's would be.
 */
function snapshot(sessionDir: string, own: string, baseName: string): void {
  try {
    const from = path.join(sessionDir, own);
    const to = path.join(sessionDir, baseName);
    if (existsSync(from)) copyFileSync(from, to);
    else writeFileSync(to, '{}\n', 'utf8');
  } catch {
    /* see LEGACY_SETTINGS */
  }
}

/**
 * Forget what an earlier session in this folder started from. A folder that
 * could not be cleared when its session died keeps its records, and the next
 * session would judge its own changes against that one's start.
 */
export function forgetEarlierStart(sessionDir: string): void {
  try {
    for (const name of readdirSync(sessionDir)) {
      if (name.startsWith('.ccx-base.')) rmSync(path.join(sessionDir, name), { force: true });
    }
  } catch {
    /* a fresh folder: nothing to forget */
  }
}

/** Remember the settings a session starts with. */
export function snapshotSettingsBase(sessionDir: string): void {
  snapshot(sessionDir, 'settings.json', SETTINGS_BASE);
}

/** Remember Claude's state as the session first set it up (once; later swaps keep it). */
export function snapshotStateBase(sessionDir: string): void {
  if (existsSync(path.join(sessionDir, STATE_BASE))) return;
  snapshot(sessionDir, '.claude.json', STATE_BASE);
}

/**
 * Apply what changed from `base` to `ours` onto `theirs`, at one key, leaving
 * `theirs` alone where it changed too. Returns whether `theirs` changed.
 */
function carryValue(base: Json, ours: Json, theirs: Json, key: string): boolean {
  const b = base[key];
  const o = ours[key];
  if (isDeepStrictEqual(b, o)) return false; // the session did not touch it
  if (!isDeepStrictEqual(theirs[key], b)) return false; // the user did: theirs wins
  if (o === undefined) delete theirs[key];
  else theirs[key] = o;
  return true;
}

/** The same, for a list taken as a set: the session's additions and removals. */
function carrySet(base: unknown, ours: unknown, theirs: unknown): unknown[] | null {
  const b = Array.isArray(base) ? base : [];
  const o = Array.isArray(ours) ? ours : [];
  const t = Array.isArray(theirs) ? [...theirs] : [];
  const has = (list: unknown[], v: unknown): boolean => list.some((x) => isDeepStrictEqual(x, v));
  const added = o.filter((v) => !has(b, v) && !has(t, v));
  const removed = b.filter((v) => !has(o, v));
  if (added.length === 0 && !removed.some((v) => has(t, v))) return null;
  return [...t.filter((v) => !has(removed, v)), ...added];
}

/** Whether the list at `key`, under `trail`, is a set (see SET_LISTS). */
function isSetList(trail: readonly string[], key: string): boolean {
  return SET_LISTS.has(key) || (trail.length === 1 && trail[0] === 'hooks');
}

/**
 * Apply what the session changed from `base` to `ours` onto `theirs`, in place:
 * objects key by key, set lists entry by entry, anything else as a value. What
 * the user's file changed too stays theirs, and what it removed stays removed,
 * edits inside it included. Returns whether `theirs` changed; what changed is
 * added to `changes`, as dotted paths (`permissions.allow`).
 */
function merge3(
  base: Json,
  ours: Json,
  theirs: Json,
  trail: readonly string[] = [],
  changes: string[] = [],
): boolean {
  let changed = false;
  for (const key of new Set([...Object.keys(base), ...Object.keys(ours)])) {
    const b = base[key];
    const o = ours[key];
    const t = theirs[key];
    if (isDeepStrictEqual(b, o)) continue; // the session did not touch it
    if (isObject(o) && isObject(t) && (b === undefined || isObject(b))) {
      const inner: Json = { ...t };
      if (merge3(b ?? {}, o, inner, [...trail, key], changes)) {
        theirs[key] = inner;
        changed = true;
      }
      continue;
    }
    const where = [...trail, key].join('.');
    const listOrNone = (v: unknown): boolean => v === undefined || Array.isArray(v);
    // A list the user's file removed is left removed (the value carry below).
    if (isSetList(trail, key) && listOrNone(b) && listOrNone(o) && (Array.isArray(t) || b === undefined)) {
      const merged = carrySet(b, o, t);
      if (merged) {
        // The session removed the list and nothing of the user's is left in it.
        if (o === undefined && merged.length === 0) delete theirs[key];
        else theirs[key] = merged;
        changed = true;
        changes.push(where);
      }
      continue;
    }
    if (carryValue(base, ours, theirs, key)) {
      changed = true;
      // Only the model's value is said: other values (an `env` entry) can hold
      // a secret, and the log is a plain file.
      changes.push(key === 'model' && trail.length === 0 && typeof o === 'string' ? `model ${o}` : where);
    }
  }
  return changed;
}

/** Say what a hand-back wrote, so it can be found again (`ccx history`). */
function logHandBack(c: PathCtx, file: string, changes: readonly string[]): void {
  if (changes.length === 0) return;
  try {
    appendEvent(configHome(c), `saved to your ${file}: ${changes.join(', ')}`, Date.now(), {
      kind: 'write-back',
      data: { file, changes: [...changes] },
    });
  } catch {
    /* the log is a record, never a reason to fail the hand-back */
  }
}

type Sides = { base: Json; ours: Json; legacy: boolean } | 'nothing' | 'unreadable';

/** The session's own file and what it started as (see LEGACY_SETTINGS). */
function sides(sessionDir: string, own: string, baseName: string): Sides {
  const file = path.join(sessionDir, own);
  if (!existsSync(file)) return 'nothing';
  const ours = readObject(file);
  // It may hold the only copy of a change, so it is not passed over as empty.
  if (!ours) return 'unreadable';
  const baseFile = path.join(sessionDir, baseName);
  if (!existsSync(baseFile)) return { base: {}, ours, legacy: true };
  const base = readObject(baseFile);
  return base ? { base, ours, legacy: false } : 'unreadable';
}

type Merged = { changed: boolean; theirs: Json; undo?: () => void } | null;

/**
 * Read the user's file, merge the session's changes into it, and write it back:
 * under ccx's write-back lock, so two sessions handing back at once cannot
 * overwrite each other's change, and only if nothing else (plain `claude`, an
 * edit by hand) wrote the file while this was merging. If something did, the
 * merge is done again from what is there now. A file that does not parse
 * holds the user's own work and is never rewritten.
 */
export function mergeInto(
  userFile: string,
  c: PathCtx,
  merge: (theirs: Json) => Merged,
): 'written' | 'unchanged' | 'failed' {
  const attempt = (): 'written' | 'unchanged' | 'failed' | 'again' => {
    const before = readText(userFile);
    if (before === undefined) return 'failed';
    const theirs = before === null || before.trim() === '' ? {} : parseObject(before);
    if (!theirs) return 'failed';
    const result = merge(theirs);
    if (!result) return 'failed';
    if (!result.changed) return 'unchanged';
    if (readText(userFile) !== before) {
      result.undo?.();
      return 'again';
    }
    try {
      writeFileAtomic(userFile, `${JSON.stringify(result.theirs, null, 2)}\n`);
      return 'written';
    } catch {
      result.undo?.();
      return 'failed';
    }
  };
  const locked = withWriteBackLock(c, () => {
    for (let tries = 0; tries < 3; tries += 1) {
      const outcome = attempt();
      if (outcome !== 'again') return outcome;
    }
    return 'failed';
  });
  return locked ?? 'failed';
}

/**
 * ccx's own lock for handing back, shared by every ccx session. Not taken
 * within a few seconds (a holder that is stuck), the hand-back waits for a
 * later try rather than race it.
 */
function withWriteBackLock<T>(c: PathCtx, fn: () => T): T | null {
  let lock: LockHandle;
  try {
    const home = configHome(c);
    mkdirSync(home, { recursive: true });
    lock = acquireLockDir(path.join(home, 'write-back.lock'), { waitMs: 5000 });
  } catch {
    return null;
  }
  if (!lock.held) return null;
  try {
    return fn();
  } finally {
    lock.release();
  }
}

/** A file's text; null when it is not there, undefined when it cannot be read. */
function readText(file: string): string | null | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
}

function parseObject(text: string): Json | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Handed back: the next hand-back starts from here, so nothing goes twice. */
function advanceBase(sessionDir: string, own: string, baseName: string): boolean {
  try {
    copyFileSync(path.join(sessionDir, own), path.join(sessionDir, baseName));
    return true;
  } catch {
    return false;
  }
}

/** Hand back a session's settings changes. True when nothing is left to hand back. */
export function returnSettings(sessionDir: string, c: PathCtx = {}): boolean {
  const found = sides(sessionDir, 'settings.json', SETTINGS_BASE);
  if (found === 'nothing') return true;
  if (found === 'unreadable') return false;
  let userFile: string;
  try {
    userFile = path.join(defaultClaudeRoot(c), 'settings.json');
  } catch {
    return true;
  }
  const ours = found.legacy ? pick(found.ours, LEGACY_SETTINGS) : found.ours;
  let changes: string[] = [];
  const outcome = mergeInto(userFile, c, (theirs) => {
    changes = []; // each attempt merges afresh; the one written is the one said
    const lineBefore = theirs.statusLine;
    const changed = merge3(found.base, ours, theirs, [], changes);
    // A line set inside a session goes in wrapped by ccx's, never over it. One
    // removed inside a session leaves ccx's own, as `ccx on` would with no line.
    if (changed && isOurs(lineBefore) && !isOurs(theirs.statusLine)) {
      const kept = keepOursOver(theirs, c);
      return kept ? { changed, theirs: kept.settings, undo: kept.undo } : null;
    }
    return { changed, theirs };
  });
  // Not handed back: tried again later, or kept aside (handBackOrRescue).
  if (outcome === 'failed') return false;
  if (outcome === 'written') logHandBack(c, 'settings.json', changes);
  return advanceBase(sessionDir, 'settings.json', SETTINGS_BASE);
}

/** The user's own choices in Claude's state, and nothing else of it. */
function stateChoices(state: Json): Json {
  const view = pick(state, STATE_PREFS);
  if (isObject(state.mcpServers)) view.mcpServers = state.mcpServers;
  if (isObject(state.projects)) {
    const projects: Json = {};
    for (const [folder, record] of Object.entries(state.projects)) {
      if (isObject(record)) projects[folder] = pick(record, PROJECT_CHOICES);
    }
    view.projects = projects;
  }
  return view;
}

/** Hand back what a session changed in Claude's own state. True when nothing is left. */
export function returnState(sessionDir: string, c: PathCtx = {}): boolean {
  const found = sides(sessionDir, '.claude.json', STATE_BASE);
  if (found === 'nothing') return true;
  if (found === 'unreadable') return false;
  if (found.legacy) return true; // see LEGACY_SETTINGS
  let userFile: string;
  try {
    userFile = defaultClaudeJsonPath(c);
  } catch {
    return true;
  }
  const base = stateChoices(found.base);
  const ours = stateChoices(found.ours);
  let changes: string[] = [];
  const outcome = mergeInto(userFile, c, (theirs) => {
    changes = [];
    return { changed: merge3(base, ours, theirs, [], changes), theirs };
  });
  if (outcome === 'failed') return false;
  if (outcome === 'written') logHandBack(c, '.claude.json', changes);
  return advanceBase(sessionDir, '.claude.json', STATE_BASE);
}

/** Hand back everything a session changed in the user's settings and state. */
export function returnSessionChanges(sessionDir: string, c: PathCtx = {}): boolean {
  const settings = returnSettings(sessionDir, c);
  const state = returnState(sessionDir, c);
  return settings && state;
}

/**
 * Before a session folder is removed: hand its changes back, or, when they
 * cannot go back (a real file that does not parse, a write that failed), keep
 * the session's own files aside in `rescued/` in the ccx folder. False only
 * when even that failed: the folder holds the only copy and must stay.
 */
export function handBackOrRescue(sessionDir: string, c: PathCtx = {}): boolean {
  if (returnSessionChanges(sessionDir, c)) return true;
  const owner = path.basename(sessionDir);
  let kept = true;
  for (const name of ['settings.json', '.claude.json']) {
    const file = path.join(sessionDir, name);
    if (existsSync(file) && !rescue(file, `${owner}-${name}`, c)) kept = false;
  }
  return kept;
}

/**
 * Between two runs of Claude in one session: hand back what the last run
 * changed, then start the next from the user's settings as they are now, the
 * way a fresh `claude` would, so a change made elsewhere meanwhile (in another
 * session, in plain `claude`, by hand) reaches this one too.
 *
 * Only once the hand-back succeeded: copying over a change that could not go
 * back would lose it. Claude's state is handed back but not replaced, because
 * the session's copy carries the account it is signed in as.
 */
export function resyncSession(sessionDir: string, c: PathCtx = {}): void {
  const settingsBack = returnSettings(sessionDir, c);
  returnState(sessionDir, c);
  if (settingsBack && copyUserSettings(sessionDir, c)) snapshotSettingsBase(sessionDir);
}
