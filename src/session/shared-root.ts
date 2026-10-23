import {
  appendFileSync,
  type BigIntStats,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  linkSync,
  copyFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { configHome, homeDir, type PathCtx } from '../config/paths.js';
import { writeFileAtomic } from '../util/atomic-write.js';
import { writeSecretFile } from '../util/secret-file.js';
import { setTarget, isLink } from '../daemon/junction.js';

/**
 * Claude keeps transcripts, /resume history, and per-project memories under
 * <config root>/projects. ccx runs sessions under its own config root (so it can
 * swap credentials), which would split that history: /resume in a ccx session
 * would not see sessions from plain `claude`, and vice versa. These helpers make
 * the ccx session root SHARE the user's real ~/.claude data instead of forking it.
 */

/** The user's default claude config root (~/.claude). */
export function defaultClaudeRoot(c: PathCtx = {}): string {
  return path.join(homeDir(c), '.claude');
}

/**
 * Ensure <sessionDir>/projects is a link to ~/.claude/projects so both roots see
 * ONE session/memory store. Self-healing and never lossy:
 * - already a link: done.
 * - missing: link it.
 * - a real directory: move it aside, link, then merge the moved content into the
 *   shared store (hardlink same-volume, copy otherwise; existing files win).
 * - anything locked/busy (a live session): skip now, heal on the next start.
 * Returns true when the link is in place.
 */
export function ensureSharedProjects(sessionDir: string, c: PathCtx = {}): boolean {
  return ensureSharedDir(sessionDir, 'projects', c);
}

/**
 * The same, for any folder of ~/.claude: `<sessionDir>/<name>` becomes a link to
 * `~/.claude/<name>`, by the same self-healing, never lossy steps.
 */
export function ensureSharedDir(sessionDir: string, name: string, c: PathCtx = {}): boolean {
  let target: string;
  try {
    target = path.join(defaultClaudeRoot(c), name);
  } catch {
    return false; // no resolvable home: nothing to share
  }
  const link = path.join(sessionDir, name);
  try {
    mkdirSync(target, { recursive: true });
    if (isLink(link)) return true;
    if (!existsSync(link)) {
      setTarget(link, target, { platform: c.platform });
      return true;
    }
    // A real directory with prior ccx-side content: move it aside first (fails
    // EBUSY/EPERM if a live session holds files open -- then we just skip).
    const backup = `${link}.pre-share`;
    renameSync(link, uniquePath(backup));
    setTarget(link, target, { platform: c.platform });
    mergeTree(latestBackup(sessionDir, name), target);
    return true;
  } catch {
    return isLink(link); // busy or blocked: report the current state
  }
}

/**
 * What of ~/.claude a session shares, which is everything but its login.
 *
 * A ccx session runs Claude on a config folder of its own, because that is the
 * only place Claude reads its login from, and a login per session is what lets
 * one session change account in place. Everything ELSE Claude keeps in that
 * folder used to be the session's own too, and gone with it: prompt history,
 * /rewind checkpoints, plugins (a fresh 400 MB install per session), the
 * editor link /ide looks for, todos and plans, skills and agents. Every
 * folder is now a link to the one in ~/.claude, so a ccx session is the
 * user's own Claude except for which account it is on.
 *
 * The folders Claude is known to use are linked even before ~/.claude has
 * them, so what a session creates lands there; anything else found in
 * ~/.claude is linked as it is.
 */
const KNOWN_SHARED_DIRS = [
  'skills',
  'agents',
  'commands',
  'output-styles',
  'plugins',
  'file-history',
  'ide',
  'todos',
  'plans',
  'paste-cache',
  'shell-snapshots',
  'session-env',
  'sessions',
];
/**
 * Stays the session's own: Claude's backups of this session's .claude.json
 * (which is per session, for the account in it), and `projects`, which is
 * shared separately (ensureSharedProjects).
 */
const OWN_DIRS = new Set(['backups', 'projects']);

/**
 * A lock Claude or ccx holds as a folder (`.oauth_refresh.lock` and the like):
 * each Claude folder's own, never shared or merged, since a link to another
 * folder's would hand one Claude's lock to another.
 */
const isLockFolder = (name: string): boolean => name.endsWith('.lock');

/** The folders a session links to ~/.claude: the known ones, and whatever else is there but locks. */
export function sharedDirNames(root: string): string[] {
  const names = new Set(KNOWN_SHARED_DIRS);
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      // A folder, or a link to one: a dotfiles setup links folders in from elsewhere.
      const full = path.join(root, entry.name);
      if (entry.isDirectory() || (entry.isSymbolicLink() && isDirectoryAt(full))) names.add(entry.name);
    }
  } catch {
    /* no ~/.claude yet: the known ones */
  }
  return [...names].filter((n) => !OWN_DIRS.has(n) && !isLockFolder(n));
}

const lstatOrNull = (p: string): ReturnType<typeof lstatSync> | null => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

/** Whether two paths are one file (a hard link), both present. */
const sameFile = (a: string, b: string): boolean => {
  try {
    const x = statSync(a, { bigint: true });
    const y = statSync(b, { bigint: true });
    return x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
};

const isDirectoryAt = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Files are hard links where the volume allows, so an edit made inside a
 * session lands in the user's own file. A copy otherwise. A file edited whole
 * is also remembered as the session started (see planWhole); prompt history
 * only ever grows, so what goes back from it is the lines the user's lacks.
 */
const SHARED_FILES: ReadonlyArray<{ name: string; merge: 'whole' | 'lines' }> = [
  { name: 'CLAUDE.md', merge: 'whole' },
  { name: 'keybindings.json', merge: 'whole' },
  { name: 'history.jsonl', merge: 'lines' },
];

/** Where a shared file is remembered as the session started. */
const baseOf = (sessionDir: string, name: string): string => path.join(sessionDir, `.ccx-base.${name}`);

/**
 * Hand back what a session changed in the user's own files, before its folder
 * is removed. A hard link shares an edit made in place, but an editor that
 * saves by writing a new file and renaming it over the old one leaves the
 * session holding the only copy, and so does a copy where links were refused,
 * and a CLAUDE.md first written inside a session (a memory saved there) was
 * never linked at all. See planWhole for what goes back.
 *
 * Written whole or not at all, so a failed write never leaves the user's own
 * file half done. Prompt history is only added to instead, because every Claude
 * session appends to it, and replacing it would drop a line one of them wrote
 * meanwhile. What cannot go back, or must not because the user changed
 * the same file meanwhile, is kept in `rescued/` in the ccx folder instead.
 * False when even that failed, or there is no ~/.claude to hand back to: the
 * session folder must then stay, because it holds the only copy.
 */
export function returnSharedUserFiles(sessionDir: string, c: PathCtx = {}): boolean {
  let root: string;
  try {
    root = defaultClaudeRoot(c);
  } catch {
    return false; // with no ~/.claude to link to, the session's folder holds all it made
  }
  let kept = true;
  for (const { name, merge } of SHARED_FILES) {
    const from = path.join(sessionDir, name);
    const to = path.join(root, name);
    if (!existsSync(from)) continue;
    let plan: { write: string | null; keepAside: boolean; append?: boolean };
    try {
      plan =
        merge === 'lines'
          ? { write: missingLines(from, to), keepAside: false, append: true }
          : planWhole(from, to, baseOf(sessionDir, name));
    } catch {
      // Could not even be compared: it may hold the only copy of an edit, so
      // it is kept aside like a write that failed, never simply dropped.
      if (!rescue(from, name, c)) kept = false;
      continue;
    }
    if (plan.keepAside && !rescue(from, name, c)) kept = false;
    if (plan.write === null) continue;
    try {
      if (plan.append) {
        mkdirSync(root, { recursive: true });
        appendFileSync(to, plan.write);
      } else {
        writeFileAtomic(to, plan.write);
      }
    } catch {
      if (!rescue(from, name, c)) kept = false;
    }
  }
  // A folder that should have been a link but is the session's own (one made
  // before it was shared, or a link that could not be made) is merged in,
  // never over what is there: /rewind checkpoints and todos made in it go
  // on being found, a file the user has too is settled by adoptClash (kept in
  // `rescued/<session>-<folder>/` unless it is part of the user's, or the
  // user's and more), and the session folder stays while one cannot be.
  // Plugins are not: an install is the user's own to manage.
  const owner = path.basename(sessionDir);
  for (const name of sharedDirNames(root)) {
    if (name === 'plugins' || name === 'sessions') continue;
    const own = path.join(sessionDir, name);
    try {
      if (!existsSync(own) || isLink(own) || !lstatSync(own).isDirectory()) continue;
      mkdirSync(path.join(root, name), { recursive: true });
      if (!mergeTree(own, path.join(root, name), adoptClash(`${owner}-${name}`, c))) kept = false;
    } catch {
      kept = false;
    }
  }
  return kept;
}

/**
 * The session's lines the user's history lacks, ready to append, or null when
 * there are none. History only grows, so a session whose link broke holds the
 * user's lines plus its own.
 */
function missingLines(from: string, to: string): string | null {
  if (existsSync(to)) {
    const mine = statSync(from, { bigint: true });
    const theirs = statSync(to, { bigint: true });
    if (mine.ino === theirs.ino && mine.dev === theirs.dev) return null; // still one file
  }
  const theirs = existsSync(to) ? readFileSync(to, 'utf8') : '';
  const known = new Set(theirs.split('\n'));
  const added = readFileSync(from, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !known.has(line));
  if (added.length === 0) return null;
  const sep = theirs === '' || theirs.endsWith('\n') ? '' : '\n';
  return `${sep}${added.join('\n')}\n`;
}

/**
 * What goes back of a file edited whole (CLAUDE.md, keybindings.json), judged
 * by what the session started from: the session's copy when only the session
 * changed it, nothing when it did not, and when the user's changed as well,
 * the user's stays and the session's is kept aside, so neither edit is lost.
 * A file the user removed meanwhile, untouched in the session, stays removed.
 *
 * A folder an older ccx left has no record of the start: there the newer copy
 * goes back, and an older one that differs is kept aside rather than dropped.
 */
function planWhole(from: string, to: string, baseFile: string): { write: string | null; keepAside: boolean } {
  const none = { write: null, keepAside: false };
  const mine = readFileSync(from);
  const back = { write: mine.toString('utf8'), keepAside: false };
  const base = existsSync(baseFile) ? readFileSync(baseFile) : null;
  if (!existsSync(to)) {
    // The user had none at the start (an empty record): the session's is new.
    if (!base || base.length === 0) return back;
    // The user deleted theirs since: untouched in the session, it stays
    // deleted; edited there too, the edit is kept aside, not resurrected.
    return mine.equals(base) ? none : { write: null, keepAside: true };
  }
  const a = statSync(from, { bigint: true });
  const b = statSync(to, { bigint: true });
  if (a.ino === b.ino && a.dev === b.dev) return none; // still one file
  const theirs = readFileSync(to);
  if (mine.equals(theirs)) return none;
  if (base) {
    if (mine.equals(base)) return none; // the session did not change it
    if (theirs.equals(base)) return back; // only the session did
    return { write: null, keepAside: true }; // both did: theirs stays
  }
  return a.mtimeMs > b.mtimeMs ? back : { write: null, keepAside: true };
}

/**
 * Remember a file edited whole as the session starts it, empty when the user
 * has none, so what the session does to it can be told apart from what the
 * user does meanwhile. Without it, the folder is judged by age, as an older
 * ccx's is.
 */
function rememberStart(sessionDir: string, name: string, userFile: string): void {
  const base = baseOf(sessionDir, name);
  try {
    if (existsSync(base)) return;
    if (existsSync(userFile)) copyFileSync(userFile, base);
    else writeFileSync(base, '');
  } catch {
    /* see above */
  }
}

/** Keep `from` in `rescued/` in the ccx folder. False when even that failed. */
export function rescue(from: string, name: string, c: PathCtx): boolean {
  try {
    const target = path.join(configHome(c), 'rescued', `${Date.now()}-${name}`);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(from, target);
    return true;
  } catch {
    return false;
  }
}

/** Keep `text` in `rescued/` as `name`, owner-only, since it can hold a setting's secret. False when that failed. */
export function rescueText(text: string, name: string, c: PathCtx): boolean {
  try {
    writeSecretFile(path.join(configHome(c), 'rescued', `${Date.now()}-${name}`), text);
    return true;
  } catch {
    return false;
  }
}

/** Link every folder of ~/.claude into `sessionDir` (ensureSharedDir): the known ones, and whatever else is there. */
export function linkSharedDirs(sessionDir: string, c: PathCtx = {}): void {
  let root: string;
  try {
    root = defaultClaudeRoot(c);
  } catch {
    return;
  }
  for (const name of sharedDirNames(root)) ensureSharedDir(sessionDir, name, c);
}

export function ensureSharedUserConfig(sessionDir: string, c: PathCtx = {}): void {
  let root: string;
  try {
    root = defaultClaudeRoot(c);
  } catch {
    return;
  }
  linkSharedDirs(sessionDir, c);
  for (const { name, merge } of SHARED_FILES) {
    const from = path.join(root, name);
    const to = path.join(sessionDir, name);
    try {
      // A copy left by a session whose folder could not be cleared: what it held
      // has been handed back or kept aside already (retireLeftoverSessionDir),
      // and this session starts from the user's own, never from that.
      if (lstatOrNull(to) && !sameFile(from, to)) unlinkSync(to);
    } catch {
      continue; // still there: judged as an older ccx's would be (planWhole)
    }
    if (merge === 'whole') rememberStart(sessionDir, name, from);
    try {
      if (!existsSync(from) || existsSync(to)) continue;
      try {
        linkSync(from, to);
      } catch {
        copyFileSync(from, to);
      }
    } catch {
      /* best effort: a session without it still runs */
    }
  }
}

function uniquePath(base: string): string {
  if (!existsSync(base)) return base;
  let i = 2;
  while (existsSync(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

function latestBackup(sessionDir: string, name = 'projects'): string {
  const names = readdirSync(sessionDir).filter((n) => n.startsWith(`${name}.pre-share`));
  names.sort();
  const last = names[names.length - 1];
  return last ? path.join(sessionDir, last) : '';
}

/** Where src and dest both have a file: true once it is dealt with, false when it could not be. */
type Clash = (from: string, to: string, relative: string) => boolean;

/**
 * Merge src into dest, never over what is there: where both have a file,
 * `clash` decides, and without one dest's stays. False when something in src
 * could not be merged, so a caller can try again.
 */
function mergeTree(src: string, dest: string, clash?: Clash, relative = ''): boolean {
  if (!src || !existsSync(src)) return true;
  let merged = true;
  for (const entry of readdirSync(src)) {
    const from = path.join(src, entry);
    const to = path.join(dest, entry);
    const rel = path.join(relative, entry);
    try {
      const st = lstatSync(from);
      if (st.isSymbolicLink()) continue; // never follow links out of the tree
      if (st.isDirectory()) {
        mkdirSync(to, { recursive: true });
        if (!mergeTree(from, to, clash, rel)) merged = false;
      } else if (!placeFile(from, to) && clash && !clash(from, to, rel)) {
        merged = false;
      }
    } catch {
      if (lstatOrNull(from)) merged = false; // one gone since it was listed has nothing to merge
    }
  }
  return merged;
}

/** Put `from` at `to`, a hard link where the volume allows, else a copy. False when `to` is already there. */
function placeFile(from: string, to: string): boolean {
  try {
    linkSync(from, to);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
  }
  try {
    copyFileSync(from, to, fsConstants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/** Whether the first `length` bytes of two files are the same. */
function sameStart(a: string, b: string, length: bigint): boolean {
  const total = Number(length);
  const fa = openSync(a, 'r');
  try {
    const fb = openSync(b, 'r');
    try {
      const chunk = 64 * 1024;
      const ba = Buffer.alloc(chunk);
      const bb = Buffer.alloc(chunk);
      for (let at = 0; at < total; at += chunk) {
        const want = Math.min(chunk, total - at);
        if (readSync(fa, ba, 0, want, at) !== want || readSync(fb, bb, 0, want, at) !== want) return false;
        if (!ba.subarray(0, want).equals(bb.subarray(0, want))) return false;
      }
      return true;
    } finally {
      closeSync(fb);
    }
  } finally {
    closeSync(fa);
  }
}

/** The bytes of `file` from `start` to `end`. */
function readRange(file: string, start: bigint, end: bigint): Buffer {
  const out = Buffer.alloc(Number(end - start));
  const fd = openSync(file, 'r');
  try {
    if (readSync(fd, out, 0, out.length, Number(start)) !== out.length) throw new Error(`${file} is shorter than it was`);
  } finally {
    closeSync(fd);
  }
  return out;
}

const bigStatOrNull = (p: string): BigIntStats | null => {
  try {
    return statSync(p, { bigint: true });
  } catch {
    return null;
  }
};

/** Keep `from` at `base` (or `base-2` and on), once: a later pass finds it there and keeps no second copy. */
function keepFileAside(from: string, base: string): boolean {
  mkdirSync(path.dirname(base), { recursive: true });
  const size = statSync(from, { bigint: true }).size;
  let at = base;
  for (let i = 2; lstatOrNull(at); i += 1) {
    const there = bigStatOrNull(at);
    if (sameFile(from, at) || (there?.isFile() && there.size === size && sameStart(from, at, size))) return true;
    at = `${base}-${i}`;
  }
  return placeFile(from, at);
}

/**
 * Where a folder's tree (an account's, the editor's or a session's) and the
 * user's both have a file: nothing to do when the user's holds all of the
 * folder's; where the folder's is the user's and more, as a chat that ran on
 * where the old link led leaves it, the rest is added; otherwise the user's
 * stays and the folder's is kept in `rescued/<label>/`.
 */
function adoptClash(label: string, c: PathCtx): Clash {
  return (from, to, relative) => {
    try {
      const theirs = statSync(from, { bigint: true });
      const yours = bigStatOrNull(to); // through a link a dotfiles setup made
      if (yours?.isFile()) {
        if (theirs.ino === yours.ino && theirs.dev === yours.dev) return true;
        if (theirs.size <= yours.size && sameStart(from, to, theirs.size)) return true;
        // Never written to through a link: that file is not ccx's to grow.
        if (theirs.size > yours.size && !isLink(to) && sameStart(from, to, yours.size)) {
          appendFileSync(to, readRange(from, yours.size, theirs.size));
          return true;
        }
      }
      return keepFileAside(from, path.join(configHome(c), 'rescued', label, relative));
    } catch {
      return false;
    }
  };
}

/**
 * Give a session the user's REAL ~/.claude/settings.json as it is now: hooks,
 * permissions, model, status line, all of it. Without this, ccx sessions
 * silently ran WITHOUT the user's hooks and permission rules.
 *
 * Nothing of the session's own wins over it. What a session changes goes back
 * to the real file (write-back), so the real file is the one place a setting
 * lives, for ccx sessions and plain `claude` alike. ccx's own choices for a
 * session (a model to move to) go on the command line, never in here.
 *
 * False when there is nothing to copy: no real settings, or a real file that
 * does not parse, which leaves the session with what it has.
 */
export function copyUserSettings(sessionDir: string, c: PathCtx = {}): boolean {
  let userFile: string;
  try {
    userFile = path.join(defaultClaudeRoot(c), 'settings.json');
  } catch {
    return false;
  }
  const user = readJson(userFile);
  if (!user) return false;
  try {
    // Whole or not at all: a half-written file would read as no settings, and
    // the next hand-back would find nothing the session changed.
    writeFileAtomic(path.join(sessionDir, 'settings.json'), `${JSON.stringify(user, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** How a change goes into one of the user's own files: under ccx's write-back lock, as `plan` says then (write-back writeUserFile). */
export type UserFileWriter = (
  file: string,
  plan: () => { text: string; append?: boolean } | null,
) => 'written' | 'unchanged' | 'failed';

/**
 * Bring a long-lived folder's copies of the user's files (SHARED_FILES) into
 * step with the user's, both ways, and make each the user's file again.
 *
 * They are hard links, one file, until something saves one by writing a new
 * file in its place; then the two have drifted apart. They are compared as a
 * session's hand-back compares them (planWhole against the folder's base, or
 * the history's missing lines), what goes back is written into the user's file,
 * an edit both sides made is kept in `rescued/` while the user's stays, and the
 * folder's becomes a link to the user's again, its base moved to it. The
 * folder's copy is moved aside first, so a write Claude makes to it meanwhile
 * lands in a new file, which the next sync takes up, rather than being lost.
 * True when every file is in step.
 */
export function syncSharedFiles(dir: string, c: PathCtx, writeUser: UserFileWriter): boolean {
  let root: string;
  try {
    root = defaultClaudeRoot(c);
  } catch {
    return true;
  }
  let inStep = true;
  for (const { name, merge } of SHARED_FILES) {
    try {
      if (!syncSharedFile(dir, root, name, merge, c, writeUser)) inStep = false;
    } catch {
      inStep = false;
    }
  }
  return inStep;
}

function syncSharedFile(
  dir: string,
  root: string,
  name: string,
  merge: 'whole' | 'lines',
  c: PathCtx,
  writeUser: UserFileWriter,
): boolean {
  const mine = path.join(dir, name);
  const theirs = path.join(root, name);
  if (!lstatOrNull(mine)) return takeTheirs(dir, name, merge, theirs, mine);
  if (existsSync(theirs) && sameFile(mine, theirs)) return true;
  const aside = uniquePath(`${mine}.ccx-sync`);
  renameSync(mine, aside);
  let keepAside = false;
  const outcome = writeUser(theirs, () => {
    if (merge === 'lines') {
      const added = missingLines(aside, theirs);
      return added === null ? null : { text: added, append: true };
    }
    const plan = planWhole(aside, theirs, baseOf(dir, name));
    keepAside = plan.keepAside;
    return plan.write === null ? null : { text: plan.write };
  });
  if (outcome === 'failed' || (keepAside && !rescue(aside, name, c))) {
    // Put back as it was, so nothing in it is lost; one Claude wrote meanwhile is newer, and stays.
    if (!lstatOrNull(mine)) renameSync(aside, mine);
    else if (rescue(aside, name, c)) rmSync(aside, { force: true });
    return false;
  }
  rmSync(aside, { force: true });
  // Written meanwhile: the user's file has what was aside, and the next sync compares the new one.
  if (lstatOrNull(mine)) return false;
  return takeTheirs(dir, name, merge, theirs, mine);
}

/** The folder's copy of `name` becomes the user's file again, and what both agree on is its base. */
function takeTheirs(dir: string, name: string, merge: 'whole' | 'lines', theirs: string, mine: string): boolean {
  if (existsSync(theirs)) {
    try {
      linkSync(theirs, mine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      copyFileSync(theirs, mine);
    }
  }
  if (merge === 'whole') writeFileAtomic(baseOf(dir, name), existsSync(theirs) ? readFileSync(theirs, 'utf8') : '');
  return true;
}

/**
 * Bring what an account's own folder holds of the user's Claude into the
 * user's ~/.claude, from when the editor ran there: its chats, checkpoints and
 * other folders merged in (never over what is there, hard links where the
 * volume allows, so nothing is copied and the account folder keeps its own;
 * a file both have is settled by adoptClash), and the prompts the user's
 * history lacks. With `rescueFiles`, its own
 * settings, memory and keybindings that are not the user's are kept in
 * `rescued/` rather than applied. False when the history or a folder could
 * not be merged, or there is no ~/.claude to merge into, so the caller can try
 * again.
 */
export function adoptFolderHistory(
  folder: string,
  label: string,
  c: PathCtx,
  writeUser: UserFileWriter,
  rescueFiles: boolean,
): boolean {
  let root: string;
  try {
    root = defaultClaudeRoot(c);
  } catch {
    return false; // no ~/.claude to merge into yet: tried again later
  }
  let merged = true;
  for (const name of ['projects', ...sharedDirNames(root)]) {
    // Another Claude's install, live records and editor links are no history.
    if (name === 'plugins' || name === 'sessions' || name === 'ide') continue;
    const own = path.join(folder, name);
    try {
      if (!existsSync(own) || isLink(own) || !lstatSync(own).isDirectory()) continue;
      mkdirSync(path.join(root, name), { recursive: true });
      if (!mergeTree(own, path.join(root, name), adoptClash(`${label}-${name}`, c))) merged = false;
    } catch {
      merged = false; // the rest still merge
    }
  }
  const history = path.join(folder, 'history.jsonl');
  const theirs = path.join(root, 'history.jsonl');
  if (existsSync(history) && !isLink(history)) {
    const outcome = writeUser(theirs, () => {
      const added = missingLines(history, theirs);
      return added === null ? null : { text: added, append: true };
    });
    if (outcome === 'failed') merged = false;
  }
  if (!rescueFiles) return merged;
  for (const name of ['settings.json', 'CLAUDE.md', 'keybindings.json']) {
    const own = path.join(folder, name);
    try {
      if (!existsSync(own) || isLink(own)) continue;
      const user = path.join(root, name);
      if (existsSync(user) && readFileSync(own).equals(readFileSync(user))) continue;
      if (!rescueOnce(own, `${label}-${name}`, c)) merged = false;
    } catch {
      merged = false; // not kept: a folder that is removed later must wait for it
    }
  }
  return merged;
}

/** Whether `rescued/` already holds these bytes under `name`. */
function keptAlready(bytes: Buffer, name: string, c: PathCtx): boolean {
  let dir: string;
  let entries: string[];
  try {
    dir = path.join(configHome(c), 'rescued');
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  return entries.some((entry) => {
    if (!entry.endsWith(`-${name}`)) return false;
    try {
      return readFileSync(path.join(dir, entry)).equals(bytes);
    } catch {
      return false;
    }
  });
}

/** rescue(), unless `rescued/` already holds the same bytes under `name`: a pass run again keeps no second copy. */
export function rescueOnce(from: string, name: string, c: PathCtx): boolean {
  let bytes: Buffer;
  try {
    bytes = readFileSync(from);
  } catch {
    return false;
  }
  return keptAlready(bytes, name, c) || rescue(from, name, c);
}

/** rescueText(), unless `rescued/` already holds `text` under `name`. */
export function rescueTextOnce(text: string, name: string, c: PathCtx): boolean {
  return keptAlready(Buffer.from(text), name, c) || rescueText(text, name, c);
}

/** Claude's own backups of the folder's state, an install, live records and editor links: nothing to keep. */
const NOT_KEPT_AT_REMOVAL = new Set(['backups', 'plugins', 'sessions', 'ide']);

/**
 * Before a long-lived Claude folder is removed, bring into ~/.claude every
 * folder it holds of its own rather than by link, by adoptFolderHistory's rule
 * for a file both have: one its Claude made that ~/.claude did not have, and
 * one moved aside when it was linked (`<name>.pre-share`). False when one
 * could not be merged, so the folder must stay.
 */
export function returnOwnFolders(dir: string, label: string, c: PathCtx): boolean {
  let root: string;
  try {
    root = defaultClaudeRoot(c);
  } catch {
    return false; // with no ~/.claude to link to, the folder holds everything of its own
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  let merged = true;
  for (const entry of entries) {
    const own = path.join(dir, entry);
    const aside = entry.indexOf('.pre-share');
    const name = aside > 0 ? entry.slice(0, aside) : entry;
    if (NOT_KEPT_AT_REMOVAL.has(name) || isLockFolder(name)) continue;
    try {
      if (isLink(own) || !lstatSync(own).isDirectory()) continue;
      mkdirSync(path.join(root, name), { recursive: true });
      if (!mergeTree(own, path.join(root, name), adoptClash(`${label}-${name}`, c))) merged = false;
    } catch {
      merged = false;
    }
  }
  return merged;
}
