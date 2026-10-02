import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  linkSync,
  copyFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { configHome, homeDir, type PathCtx } from '../config/paths.js';
import { writeFileAtomic } from '../util/atomic-write.js';
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

/** The folders a session links to ~/.claude: the known ones, and whatever else is there. */
export function sharedDirNames(root: string): string[] {
  const names = new Set(KNOWN_SHARED_DIRS);
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) names.add(entry.name);
    }
  } catch {
    /* no ~/.claude yet: the known ones */
  }
  return [...names].filter((n) => !OWN_DIRS.has(n));
}

/**
 * Files are hard links where the volume allows, so an edit made inside a
 * session lands in the user's own file. A copy otherwise. Either way
 * returnSharedUserFiles hands back what only the session ended up holding:
 * the newer copy for a file edited whole, the missing lines for prompt
 * history, which only ever grows.
 */
const SHARED_FILES: ReadonlyArray<{ name: string; merge: 'newer' | 'lines' }> = [
  { name: 'CLAUDE.md', merge: 'newer' },
  { name: 'keybindings.json', merge: 'newer' },
  { name: 'history.jsonl', merge: 'lines' },
];

/**
 * Hand back what a session changed in the user's own files, before its folder
 * is removed. A hard link shares an edit made in place, but an editor that
 * saves by writing a new file and renaming it over the old one leaves the
 * session holding the only copy, and so does a copy where links were refused,
 * and a CLAUDE.md first written inside a session (a memory saved there) was
 * never linked at all. A file that is newer than the user's and differs from
 * it, or that the user has none of, goes back; one that is still the same
 * file, or older, or identical, is left alone.
 *
 * Written whole or not at all, so a failed write never leaves the user's own
 * file half done. When it cannot go back, it is kept in `rescued/` in the ccx
 * folder instead. False only when even that failed: the session folder must
 * then stay, because it holds the only copy.
 */
export function returnSharedUserFiles(sessionDir: string, c: PathCtx = {}): boolean {
  let root: string;
  try {
    root = defaultClaudeRoot(c);
  } catch {
    return true;
  }
  let kept = true;
  for (const { name, merge } of SHARED_FILES) {
    const from = path.join(sessionDir, name);
    const to = path.join(root, name);
    if (!existsSync(from)) continue;
    let content: string | null;
    try {
      content = merge === 'lines' ? missingLines(from, to) : shouldHandBack(from, to) ? readFileSync(from, 'utf8') : null;
    } catch {
      // Could not even be compared: it may hold the only copy of an edit, so
      // it is kept aside like a write that failed, never simply dropped.
      if (!rescue(from, name, c)) kept = false;
      continue;
    }
    if (content === null) continue;
    try {
      writeFileAtomic(to, content);
    } catch {
      if (!rescue(from, name, c)) kept = false;
    }
  }
  // A folder that should have been a link but is the session's own (one made
  // before it was shared, or a link that could not be made) is merged in,
  // never over what is there: /rewind checkpoints and todos made in it go
  // on being found. Plugins are not: an install is the user's own to manage.
  for (const name of sharedDirNames(root)) {
    if (name === 'plugins' || name === 'sessions') continue;
    const own = path.join(sessionDir, name);
    try {
      if (!existsSync(own) || isLink(own) || !lstatSync(own).isDirectory()) continue;
      mkdirSync(path.join(root, name), { recursive: true });
      mergeTree(own, path.join(root, name));
    } catch {
      /* best effort, as at the start */
    }
  }
  return kept;
}

/**
 * The user's history with the session's lines it does not have added at the
 * end, or null when there is nothing to add. History only grows, so a session
 * whose link broke holds the user's lines plus its own.
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
  return `${theirs}${sep}${added.join('\n')}\n`;
}

/** Whether the session's `from` holds something the user's `to` does not. */
function shouldHandBack(from: string, to: string): boolean {
  if (!existsSync(to)) return true;
  const mine = statSync(from, { bigint: true });
  const theirs = statSync(to, { bigint: true });
  if (mine.ino === theirs.ino && mine.dev === theirs.dev) return false; // still one file
  if (mine.mtimeMs <= theirs.mtimeMs) return false;
  return !readFileSync(from).equals(readFileSync(to));
}

/** Keep `from` in `rescued/` in the ccx folder. False when even that failed. */
function rescue(from: string, name: string, c: PathCtx): boolean {
  try {
    const target = path.join(configHome(c), 'rescued', `${Date.now()}-${name}`);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(from, target);
    return true;
  } catch {
    return false;
  }
}

export function ensureSharedUserConfig(sessionDir: string, c: PathCtx = {}): void {
  let root: string;
  try {
    root = defaultClaudeRoot(c);
  } catch {
    return;
  }
  for (const name of sharedDirNames(root)) ensureSharedDir(sessionDir, name, c);
  for (const { name } of SHARED_FILES) {
    const from = path.join(root, name);
    const to = path.join(sessionDir, name);
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

/** Merge src into dest without overwriting anything that already exists. */
function mergeTree(src: string, dest: string): void {
  if (!src || !existsSync(src)) return;
  for (const entry of readdirSync(src)) {
    const from = path.join(src, entry);
    const to = path.join(dest, entry);
    try {
      const st = lstatSync(from);
      if (st.isSymbolicLink()) continue; // never follow links out of the tree
      if (st.isDirectory()) {
        mkdirSync(to, { recursive: true });
        mergeTree(from, to);
      } else if (!existsSync(to)) {
        try {
          linkSync(from, to); // same volume: hardlink shares bytes, no copy cost
        } catch {
          copyFileSync(from, to);
        }
      }
    } catch {
      /* skip unreadable entries; merge the rest */
    }
  }
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
    writeFileSync(path.join(sessionDir, 'settings.json'), `${JSON.stringify(user, null, 2)}\n`, 'utf8');
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
