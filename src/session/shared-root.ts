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
import { homeDir, type PathCtx } from '../config/paths.js';
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
  let target: string;
  try {
    target = path.join(defaultClaudeRoot(c), 'projects');
  } catch {
    return false; // no resolvable home: nothing to share
  }
  const link = path.join(sessionDir, 'projects');
  try {
    mkdirSync(target, { recursive: true });
    if (isLink(link)) return true;
    if (!existsSync(link)) {
      setTarget(link, target, { platform: c.platform });
      return true;
    }
    // A real directory with prior ccx-side sessions: move it aside first (fails
    // EBUSY/EPERM if a live session holds files open -- then we just skip).
    const backup = `${link}.pre-share`;
    renameSync(link, uniquePath(backup));
    setTarget(link, target, { platform: c.platform });
    mergeTree(latestBackup(sessionDir), target);
    return true;
  } catch {
    return isLink(link); // busy or blocked: report the current state
  }
}

function uniquePath(base: string): string {
  if (!existsSync(base)) return base;
  let i = 2;
  while (existsSync(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

function latestBackup(sessionDir: string): string {
  const names = readdirSync(sessionDir).filter((n) => n.startsWith('projects.pre-share'));
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
 * Settings ccx manages in the user's REAL settings file, where the real value
 * always wins over anything a session carried.
 *
 * `statusLine` is the one: `ccx on` wraps the user's own line in
 * `ccx statusline`, and that wrapper is how ccx hears which conversation and
 * which model a session is on. A session that started before the wrap still
 * held the old line, carried it out as "a change it made", and from then on it
 * overrode the real setting in every ccx session, silently taking ccx's own
 * status line away from all of them.
 */
export const USER_OWNED_SETTINGS: readonly string[] = ['statusLine'];

/**
 * Merge the user's REAL ~/.claude/settings.json (hooks, permissions, statusline)
 * into the session settings, with the session's own keys (e.g. the model pin)
 * winning on conflict, except the ones ccx manages in the real file. Without
 * this, ccx sessions silently ran WITHOUT the user's hooks and permission
 * rules. Idempotent; runs each session start so settings edits are picked up.
 */
export function mergeUserSettings(sessionDir: string, c: PathCtx = {}): void {
  let userFile: string;
  try {
    userFile = path.join(defaultClaudeRoot(c), 'settings.json');
  } catch {
    return;
  }
  const sessionFile = path.join(sessionDir, 'settings.json');
  const user = readJson(userFile);
  if (!user) return; // no real settings to inherit
  const session = readJson(sessionFile) ?? {};
  const merged = { ...user, ...session };
  for (const key of USER_OWNED_SETTINGS) {
    if (key in user) merged[key] = user[key];
  }
  try {
    writeFileSync(sessionFile, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  } catch {
    /* best effort */
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
