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
import { isOurs } from '../statusline/ours.js';

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
 * What else of ~/.claude a session has to see to be the user's own Claude.
 *
 * Only `projects` was shared, so a ccx session ran without the user's personal
 * skills, agents, slash commands and output styles, and without their user
 * memory and keybindings: all of it lives in the config folder, and a ccx
 * session runs on a folder of its own so its login can be swapped. Plain
 * `claude` and Claude Desktop see all of it; a ccx session now does too.
 */
const SHARED_DIRS = ['skills', 'agents', 'commands', 'output-styles'];
/**
 * Files are hard links where the volume allows, so an edit made inside a
 * session (`/memory`) lands in the user's own file. A copy otherwise, which a
 * session still reads correctly, it just keeps its edits to itself.
 */
const SHARED_FILES = ['CLAUDE.md', 'keybindings.json'];

export function ensureSharedUserConfig(sessionDir: string, c: PathCtx = {}): void {
  for (const name of SHARED_DIRS) ensureSharedDir(sessionDir, name, c);
  let root: string;
  try {
    root = defaultClaudeRoot(c);
  } catch {
    return;
  }
  for (const name of SHARED_FILES) {
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
 * Whether the user's REAL value for `key` wins over one a session carried.
 *
 * Only ccx's own status line does. `ccx on` wraps the user's line in
 * `ccx statusline`, and that wrapper is how ccx hears which conversation and
 * which model a session is on. A session that started before the wrap still
 * held the old line, carried it out as "a change it made", and from then on it
 * overrode the real setting in every ccx session, silently taking ccx's status
 * line away from all of them. With no ccx line in the real file there is
 * nothing of ccx's to protect, so a line set inside a session is kept as before.
 */
export function realSettingWins(key: string, user: Record<string, unknown>): boolean {
  return key === 'statusLine' && isOurs(user.statusLine);
}

/**
 * Merge the user's REAL ~/.claude/settings.json (hooks, permissions, statusline)
 * into the session settings, with the session's own keys (e.g. the model pin)
 * winning on conflict, except ccx's own status line (see realSettingWins).
 * Without this, ccx sessions silently ran WITHOUT the user's hooks and
 * permission rules. Idempotent; runs each session start so settings edits are
 * picked up.
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
  for (const key of Object.keys(session)) {
    if (realSettingWins(key, user)) merged[key] = user[key];
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
