import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { defaultClaudeJsonPath } from '../daemon/reference-config.js';
import { keepOursOver } from '../statusline/settings-install.js';
import { isOurs } from '../statusline/ours.js';
import { writeFileAtomic } from '../util/atomic-write.js';
import { copyUserSettings, defaultClaudeRoot } from './shared-root.js';
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
 * wins.
 */

const SETTINGS_BASE = '.ccx-base.settings.json';
const STATE_BASE = '.ccx-base.claude.json';

/** Lists merged as sets: what a session added or removed, not the whole list. */
const SET_LISTS = new Set(['allow', 'deny', 'ask', 'additionalDirectories']);

/** The parts of .claude.json that are the user's own doing, merged entry by entry. */
const STATE_MAPS = new Set(['projects', 'mcpServers']);
/** Preferences set through Claude itself, handed back as values. */
const STATE_PREFS = new Set([
  'theme',
  'editorMode',
  'verbose',
  'autoUpdates',
  'preferredNotifChannel',
  'autoCompactEnabled',
  'autoConnectIde',
  'diffTool',
]);

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

/** Remember the settings a session starts with. */
export function snapshotSettingsBase(sessionDir: string): void {
  try {
    copyFileSync(path.join(sessionDir, 'settings.json'), path.join(sessionDir, SETTINGS_BASE));
  } catch {
    /* none to remember: whatever the session writes counts as its change */
  }
}

/** Remember Claude's state as the session first set it up (once; later swaps keep it). */
export function snapshotStateBase(sessionDir: string): void {
  const base = path.join(sessionDir, STATE_BASE);
  if (existsSync(base)) return;
  try {
    copyFileSync(path.join(sessionDir, '.claude.json'), base);
  } catch {
    /* as above */
  }
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

/**
 * The session's own file, and what it started as. A session with nothing to
 * start from (no real settings when it began, or a folder an older ccx left
 * without one) counts everything it holds as its change: only what the user's
 * file does not have goes in, because everything the user's file does have
 * was never changed from anything the session knows of.
 */
function sides(sessionDir: string, own: string, baseName: string): { base: Json; ours: Json } | null {
  const ours = readObject(path.join(sessionDir, own));
  if (!ours) return null;
  return { base: readObject(path.join(sessionDir, baseName)) ?? {}, ours };
}

/** Hand back a session's settings changes. True when nothing is left to hand back. */
export function returnSettings(sessionDir: string, c: PathCtx = {}): boolean {
  const found = sides(sessionDir, 'settings.json', SETTINGS_BASE);
  if (!found) return true;
  const { base, ours } = found;
  let userFile: string;
  try {
    userFile = path.join(defaultClaudeRoot(c), 'settings.json');
  } catch {
    return true;
  }
  const read = existsSync(userFile) ? readObject(userFile) : {};
  // A real settings file that does not parse holds the user's hooks and
  // permissions: never rewritten, whatever this session changed.
  if (!read) return false;
  let theirs = read;
  const lineBefore = theirs.statusLine;
  let changed = false;
  for (const key of new Set([...Object.keys(base), ...Object.keys(ours)])) {
    if (isObject(base[key]) && isObject(ours[key]) && (isObject(theirs[key]) || theirs[key] === undefined)) {
      // permissions and the like: key by key, lists as sets.
      const b = base[key] as Json;
      const o = ours[key] as Json;
      const t: Json = { ...((theirs[key] as Json | undefined) ?? {}) };
      let inner = false;
      for (const sub of new Set([...Object.keys(b), ...Object.keys(o)])) {
        if (SET_LISTS.has(sub)) {
          const merged = carrySet(b[sub], o[sub], t[sub]);
          if (merged) {
            t[sub] = merged;
            inner = true;
          }
        } else if (carryValue(b, o, t, sub)) {
          inner = true;
        }
      }
      if (inner) {
        theirs[key] = t;
        changed = true;
      }
    } else if (carryValue(base, ours, theirs, key)) {
      changed = true;
    }
  }
  // A line set inside a session goes in wrapped by ccx's, never over it.
  if (changed && isOurs(lineBefore) && !isOurs(theirs.statusLine)) theirs = keepOursOver(theirs, c);
  return finish(changed, userFile, theirs, sessionDir, 'settings.json', SETTINGS_BASE);
}

/** Hand back what a session changed in Claude's own state. True when nothing is left. */
export function returnState(sessionDir: string, c: PathCtx = {}): boolean {
  const found = sides(sessionDir, '.claude.json', STATE_BASE);
  if (!found) return true;
  const { base, ours } = found;
  let userFile: string;
  try {
    userFile = defaultClaudeJsonPath(c);
  } catch {
    return true;
  }
  const theirs = existsSync(userFile) ? readObject(userFile) : {};
  if (!theirs) return false;
  let changed = false;
  for (const key of STATE_PREFS) {
    if (carryValue(base, ours, theirs, key)) changed = true;
  }
  for (const key of STATE_MAPS) {
    const b = isObject(base[key]) ? (base[key] as Json) : {};
    const o = isObject(ours[key]) ? (ours[key] as Json) : {};
    if (isDeepStrictEqual(b, o)) continue;
    const t: Json = { ...(isObject(theirs[key]) ? (theirs[key] as Json) : {}) };
    let inner = false;
    for (const entry of new Set([...Object.keys(b), ...Object.keys(o)])) {
      if (key === 'projects' && isObject(o[entry]) && isObject(b[entry] ?? {})) {
        // One folder's record, field by field: trust, allowed tools, its last
        // conversation; a field the user's own file changed meanwhile is theirs.
        const be = (b[entry] as Json | undefined) ?? {};
        const oe = o[entry] as Json;
        const te: Json = { ...(isObject(t[entry]) ? (t[entry] as Json) : {}) };
        let fields = false;
        for (const field of new Set([...Object.keys(be), ...Object.keys(oe)])) {
          if (carryValue(be, oe, te, field)) fields = true;
        }
        if (fields) {
          t[entry] = te;
          inner = true;
        }
      } else if (carryValue(b, o, t, entry)) {
        inner = true;
      }
    }
    if (inner) {
      theirs[key] = t;
      changed = true;
    }
  }
  return finish(changed, userFile, theirs, sessionDir, '.claude.json', STATE_BASE);
}

function finish(
  changed: boolean,
  userFile: string,
  theirs: Json,
  sessionDir: string,
  own: string,
  baseName: string,
): boolean {
  try {
    if (changed) writeFileAtomic(userFile, `${JSON.stringify(theirs, null, 2)}\n`);
    // Handed back: the next hand-back starts from here, so nothing goes twice.
    copyFileSync(path.join(sessionDir, own), path.join(sessionDir, baseName));
    return true;
  } catch {
    return false;
  }
}

/** Hand back everything a session changed in the user's settings and state. */
export function returnSessionChanges(sessionDir: string, c: PathCtx = {}): boolean {
  const settings = returnSettings(sessionDir, c);
  const state = returnState(sessionDir, c);
  return settings && state;
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
