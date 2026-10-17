import {
  appendFileSync,
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
import { writeSecretFile } from '../util/secret-file.js';
import { copyUserSettings, defaultClaudeRoot, rescue, rescueText } from './shared-root.js';
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
 * added to `changes`, as dotted paths (`permissions.allow`), and a value both
 * sides changed differently, where theirs stays, to `clashes`.
 */
function merge3(
  base: Json,
  ours: Json,
  theirs: Json,
  trail: readonly string[] = [],
  changes: string[] = [],
  clashes: string[] = [],
): boolean {
  let changed = false;
  for (const key of new Set([...Object.keys(base), ...Object.keys(ours)])) {
    const b = base[key];
    const o = ours[key];
    const t = theirs[key];
    if (isDeepStrictEqual(b, o)) continue; // the session did not touch it
    if (isObject(o) && isObject(t) && (b === undefined || isObject(b))) {
      const inner: Json = { ...t };
      if (merge3(b ?? {}, o, inner, [...trail, key], changes, clashes)) {
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
    if (!isDeepStrictEqual(t, b) && !isDeepStrictEqual(t, o)) clashes.push(where);
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
  // Not handed back: tried again later, or kept aside (handBackOrRescue).
  if (handBackSettings(found.base, ours, userFile, c) === 'failed') return false;
  return advanceBase(sessionDir, 'settings.json', SETTINGS_BASE);
}

/** Merge what changed from `base` to `ours` into the user's settings, and say what was written. */
function handBackSettings(
  base: Json,
  ours: Json,
  userFile: string,
  c: PathCtx,
  clashes: string[] = [],
): 'written' | 'unchanged' | 'failed' {
  let changes: string[] = [];
  const outcome = mergeInto(userFile, c, (theirs) => {
    changes = []; // each attempt merges afresh; the one written is the one said
    clashes.length = 0;
    const lineBefore = theirs.statusLine;
    const changed = merge3(base, ours, theirs, [], changes, clashes);
    // A line set inside a session goes in wrapped by ccx's, never over it. One
    // removed inside a session leaves ccx's own, as `ccx on` would with no line.
    if (changed && isOurs(lineBefore) && !isOurs(theirs.statusLine)) {
      const kept = keepOursOver(theirs, c);
      return kept ? { changed, theirs: kept.settings, undo: kept.undo } : null;
    }
    return { changed, theirs };
  });
  if (outcome === 'written') logHandBack(c, 'settings.json', changes);
  return outcome;
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
  if (handBackState(found.base, found.ours, userFile, c) === 'failed') return false;
  return advanceBase(sessionDir, '.claude.json', STATE_BASE);
}

/** Merge the choices that changed from `base` to `ours` into the user's state, and say what was written. */
function handBackState(
  base: Json,
  ours: Json,
  userFile: string,
  c: PathCtx,
  clashes: string[] = [],
): 'written' | 'unchanged' | 'failed' {
  const from = stateChoices(base);
  const to = stateChoices(ours);
  let changes: string[] = [];
  const outcome = mergeInto(userFile, c, (theirs) => {
    changes = [];
    clashes.length = 0;
    return { changed: merge3(from, to, theirs, [], changes, clashes), theirs };
  });
  if (outcome === 'written') logHandBack(c, '.claude.json', changes);
  return outcome;
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

/* A folder that never ends (the editor's): its settings and state kept in step both ways. */

/**
 * How ccx's own entries pass between a long-lived folder's settings and the
 * user's: taken out on the way to the user's file and put back on the way in,
 * so the user's file never holds them.
 */
export interface SettingsPassage {
  outgoing?: (settings: Json) => Json;
  incoming?: (settings: Json) => Json;
}

/** One file of a long-lived folder brought into step, not yet (written meanwhile, try again), or not possible. */
export type FolderSync = 'synced' | 'again' | 'failed';

/**
 * Bring a long-lived folder's settings.json and the user's into step, both ways.
 *
 * A session folder copies the user's settings in at its start and hands what it
 * changed back at its end. A folder that never ends does both at every refresh,
 * judged against what the two last agreed on, its base: what the folder changed
 * since goes into the user's file, exactly as a session's hand-back does, and
 * then the user's file, holding both, becomes the folder's. Where both changed
 * one setting differently the user's stays, as in a hand-back, and the folder's
 * file is kept in `rescued/` first. The base moves only once both are written.
 */
export function syncSettings(dir: string, c: PathCtx = {}, passage: SettingsPassage = {}): FolderSync {
  const own = path.join(dir, 'settings.json');
  const ownText = readText(own);
  if (ownText === undefined) return 'failed';
  const ours = ownText === null ? null : parseObject(ownText);
  // It may hold the only copy of a change, so it is never replaced unread.
  if (ownText !== null && !ours) return 'failed';
  const baseFile = path.join(dir, SETTINGS_BASE);
  const baseText = readText(baseFile);
  if (baseText === undefined) return 'failed';
  const base = baseText === null ? null : parseObject(baseText);
  if (baseText !== null && !base) return 'failed';
  let userFile: string;
  try {
    userFile = path.join(defaultClaudeRoot(c), 'settings.json');
  } catch {
    return 'failed';
  }
  const out = passage.outgoing ?? ((s: Json): Json => s);
  const into = passage.incoming ?? ((s: Json): Json => s);
  if (ours !== null) {
    // With no record of what they last agreed on, only its model goes, as from a folder an older ccx left.
    const going = base === null ? pick(out(ours), LEGACY_SETTINGS) : out(ours);
    const clashes: string[] = [];
    if (handBackSettings(base ?? {}, going, userFile, c, clashes) === 'failed') return 'failed';
    if (clashes.length > 0 && !keptAside(dir, 'settings.json', ownText ?? '', clashes, c)) return 'failed';
  }
  const userText = readText(userFile);
  if (userText === undefined) return 'failed';
  const user = userText === null || userText.trim() === '' ? {} : parseObject(userText);
  if (!user) return 'failed';
  // What only the folder holds, when there is no record to judge it by, is kept rather than replaced unseen.
  if (base === null && ours !== null && !isDeepStrictEqual(out(ours), user)) {
    if (!rescueText(ownText ?? '', `${path.basename(dir)}-settings.json`, c)) return 'failed';
  }
  // Over what was read only: a change Claude made here meanwhile goes out at the next sync.
  if (readText(own) !== ownText) return 'again';
  try {
    writeFileAtomic(own, `${JSON.stringify(into(user), null, 2)}\n`);
    writeFileAtomic(baseFile, `${JSON.stringify(user, null, 2)}\n`);
  } catch {
    return 'failed';
  }
  return 'synced';
}

/**
 * The same for Claude's state, `.claude.json`, where the user's MCP servers,
 * trusted folders and preferences live: the choices stateChoices names, both
 * ways, and nothing of the folder's own account or Claude's bookkeeping. The
 * folder's file is written under the lock Claude takes to write it,
 * `<file>.lock`, under which Claude 2.1.302 reads the file again before it
 * applies its own change (saveConfigWithLock), so neither change is lost.
 */
export function syncState(dir: string, c: PathCtx = {}): FolderSync {
  const own = path.join(dir, '.claude.json');
  const ownText = readText(own);
  if (ownText === undefined) return 'failed';
  if (ownText === null) return 'synced'; // no state yet: the folder's first login builds it
  const ours = parseObject(ownText);
  if (!ours) return 'failed';
  const baseFile = path.join(dir, STATE_BASE);
  const baseText = readText(baseFile);
  if (baseText === undefined) return 'failed';
  const base = baseText === null ? null : parseObject(baseText);
  if (baseText !== null && !base) return 'failed';
  let userFile: string;
  try {
    userFile = defaultClaudeJsonPath(c);
  } catch {
    return 'failed';
  }
  // With no record of what they last agreed on nothing goes, as from a folder an older ccx left.
  if (base !== null) {
    const clashes: string[] = [];
    if (handBackState(base, ours, userFile, c, clashes) === 'failed') return 'failed';
    const kept = `${JSON.stringify(stateChoices(ours), null, 2)}\n`;
    if (clashes.length > 0 && !keptAside(dir, 'claude-choices.json', kept, clashes, c)) return 'failed';
  }
  const userText = readText(userFile);
  if (userText === undefined) return 'failed';
  const user = userText === null || userText.trim() === '' ? {} : parseObject(userText);
  if (!user) return 'failed';
  // What only the folder holds, when there is no record to judge it by, is kept rather than replaced unseen.
  if (base === null && !isDeepStrictEqual(stateChoices(ours), stateChoices(user))) {
    if (!rescueText(`${JSON.stringify(stateChoices(ours), null, 2)}\n`, `${path.basename(dir)}-claude-choices.json`, c)) {
      return 'failed';
    }
  }
  const lock = acquireLockDir(`${own}.lock`, { waitMs: 500 });
  if (!lock.held) return 'again';
  try {
    if (readText(own) !== ownText) return 'again';
    const next = withChoices(ours, stateChoices(user));
    writeSecretFile(own, JSON.stringify(next));
    writeSecretFile(baseFile, JSON.stringify(next));
    return 'synced';
  } catch {
    return 'failed';
  } finally {
    lock.release();
  }
}

/** `state` with every choice stateChoices reads taken from `choices`, and the rest of it (its account, Claude's bookkeeping) as it was. */
function withChoices(state: Json, choices: Json): Json {
  const next: Json = { ...state };
  for (const key of STATE_PREFS) {
    if (key in choices) next[key] = choices[key];
    else delete next[key];
  }
  if (isObject(choices.mcpServers)) next.mcpServers = choices.mcpServers;
  else delete next.mcpServers;
  const mine = isObject(state.projects) ? state.projects : {};
  const theirs = isObject(choices.projects) ? choices.projects : {};
  const projects: Json = {};
  for (const folder of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    const was = mine[folder];
    const chosen = theirs[folder];
    const record: Json = isObject(was) ? { ...was } : {};
    const picked: Json = isObject(chosen) ? chosen : {};
    for (const key of PROJECT_CHOICES) {
      if (key in picked) record[key] = picked[key];
      else delete record[key];
    }
    projects[folder] = record;
  }
  if (isObject(state.projects) || isObject(choices.projects)) next.projects = projects;
  return next;
}

/** A folder's copy of `name`, which both sides changed, kept in `rescued/` before the user's wins; false when that failed. */
function keptAside(dir: string, name: string, text: string, clashes: readonly string[], c: PathCtx): boolean {
  const folder = path.basename(dir);
  if (!rescueText(text, `${folder}-${name}`, c)) return false;
  try {
    appendEvent(
      configHome(c),
      `${clashes.join(', ')} changed both in ${folder} and in your own file: yours stays, and ${folder}'s ${name} is kept in rescued/`,
      Date.now(),
      { kind: 'write-back', data: { file: name, clashes: [...clashes] } },
    );
  } catch {
    /* the log is a record, never a reason to fail */
  }
  return true;
}

/**
 * Change one of the user's own files (CLAUDE.md, keybindings.json,
 * history.jsonl) under ccx's write-back lock, as `plan` says from what is
 * there once the lock is held: written whole, or added to the end of.
 */
export function writeUserFile(
  file: string,
  c: PathCtx,
  plan: () => { text: string; append?: boolean } | null,
): 'written' | 'unchanged' | 'failed' {
  const outcome = withWriteBackLock(c, (): 'written' | 'unchanged' | 'failed' => {
    try {
      const step = plan();
      if (!step) return 'unchanged';
      if (step.append) {
        mkdirSync(path.dirname(file), { recursive: true });
        appendFileSync(file, step.text);
      } else {
        writeFileAtomic(file, step.text);
      }
      return 'written';
    } catch {
      return 'failed';
    }
  });
  return outcome ?? 'failed';
}

/**
 * Keep the choices an account's own folder holds in Claude's state aside in
 * `rescued/` when they are not the user's, before the editor stops running
 * there: an MCP server or a trusted folder added in the editor while it ran on
 * that account would otherwise be found nowhere.
 */
export function rescueStateChoices(folder: string, label: string, c: PathCtx = {}): void {
  try {
    const theirs = readObject(path.join(folder, '.claude.json'));
    if (!theirs) return;
    const user = readObject(defaultClaudeJsonPath(c)) ?? {};
    const choices = stateChoices(theirs);
    if (isDeepStrictEqual(choices, stateChoices(user))) return;
    rescueText(`${JSON.stringify(choices, null, 2)}\n`, `${label}-claude-choices.json`, c);
  } catch {
    /* the account folder keeps its own; nothing is lost */
  }
}
