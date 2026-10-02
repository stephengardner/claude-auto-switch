import { clearCredential, credentialPath } from '../accounts/credential-vault.js';
import { readCredential, writeCredential } from '../accounts/credential-storage.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { configHome, type PathCtx } from '../config/paths.js';
import { isLink } from '../daemon/junction.js';
import { defaultClaudeRoot, returnSharedUserFiles } from './shared-root.js';
import { writeFileAtomic } from '../util/atomic-write.js';
import { CasError } from '../util/errors.js';
import { returnSessionChanges } from './write-back.js';

/**
 * A session directory per running session, instead of one shared by all of them.
 *
 * Starting a session copies the chosen account's login into its config
 * directory, because that is how ccx makes Claude run as that account. While
 * every session shared ONE directory, the second one to start overwrote the
 * first one's login, and from that moment the first terminal was running as
 * somebody else while ccx still reported the account it had chosen.
 *
 * That is not a display problem. Two things follow from it, and both were seen:
 * a limit hit by one account gets recorded against the other, and the save-back
 * that copies a refreshed login home writes the borrowed one into the wrong
 * profile. Once two profiles hold one token, `renewalWouldBreakOthers` treats
 * them as the same account and carries every later renewal across, so they can
 * never come apart again. Three accounts here spent a day as one that way.
 *
 * Giving each session its own directory removes the shared thing they were
 * fighting over, so none of that can start.
 */

/** Where per-session directories live. */
export function sessionsRoot(c: PathCtx = {}): string {
  return path.join(configHome(c), 'sessions');
}

/** This session's own config directory. */
export function sessionDirFor(pid: number, c: PathCtx = {}): string {
  return path.join(sessionsRoot(c), String(pid));
}

/**
 * Is this a ccx terminal session directory?
 *
 * Accepts the pre-split single directory too. A session started before an
 * upgrade is still running in it, and its status line should keep working
 * rather than start reporting the session as something else.
 */
export function isSessionDir(dir: string, c: PathCtx = {}): boolean {
  const normalise = (p: string): string => {
    const forward = path.resolve(p).split('\\').join('/').replace(/\/+$/, '');
    return process.platform === 'win32' ? forward.toLowerCase() : forward;
  };
  const candidate = normalise(dir);
  if (candidate === normalise(path.join(configHome(c), 'session'))) return true;
  const root = `${normalise(sessionsRoot(c))}/`;
  // A direct child only. Anything deeper is a file inside a session, not the
  // session directory itself, and treating those as one would make the status
  // line claim a session for any path that merely lives under the root.
  return candidate.startsWith(root) && !candidate.slice(root.length).includes('/');
}

/** The pid a session directory belongs to, or null when the name is not one. */
export function pidOfSessionDir(name: string): number | null {
  if (!/^\d+$/.test(name)) return null;
  const pid = Number(name);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Where ccx used to keep a session's settings BETWEEN sessions, and laid them
 * over the user's real ones in every session it started. Read once more by
 * retireKeptSettings, and never written again.
 */
export function keptSettingsPath(c: PathCtx = {}): string {
  return path.join(configHome(c), 'session-settings.json');
}

/**
 * Fold ccx's old store of session settings into the user's real settings, once,
 * and retire it.
 *
 * The store overrode ~/.claude/settings.json in every ccx session, so ccx
 * sessions and plain `claude` could run on different models, effort and
 * screen modes off what looked like one settings file, and nothing changed in
 * the real file could reach a key the store held. Now what a session changes
 * goes straight back to the real file (write-back), and the store has no job.
 *
 * Where the real file has a value, it wins: it is the one the user can see and
 * edit, and editing it is how they tried to change it. A value only the store
 * has is the one record of a choice made in a session, and goes in. The store
 * is renamed aside, never deleted.
 */
export function retireKeptSettings(c: PathCtx = {}): void {
  const kept = keptSettingsPath(c);
  if (!existsSync(kept)) return;
  try {
    const store = readJsonObject(kept);
    if (store) {
      const userFile = path.join(defaultClaudeRoot(c), 'settings.json');
      const user = existsSync(userFile) ? readJsonObject(userFile) : {};
      // A real file that does not parse is never rewritten: the store waits.
      if (!user) return;
      const missing = Object.entries(store).filter(([key]) => !(key in user));
      if (missing.length > 0) {
        writeFileAtomic(userFile, `${JSON.stringify({ ...user, ...Object.fromEntries(missing) }, null, 2)}\n`);
      }
    }
    renameSync(kept, `${kept}.retired`);
  } catch {
    /* tried again at the next start */
  }
}

function readJsonObject(file: string): Record<string, unknown> | null {
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

/** Default liveness check: signal 0 tests for the process without touching it. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process EXISTS but belongs to someone else. Only "no
    // such process" proves it is gone, and this check guards a DELETE of a
    // directory holding a live login: guessing "dead" signs a session out.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface SweepOptions {
  /** Injected in tests. */
  isAlive?: (pid: number) => boolean;
  /** Never swept, even if the check says otherwise. */
  keepPid?: number;
}

/**
 * Remove the session directories whose process is gone, and report which.
 *
 * Session directories hold a LOGIN, so leaving them behind after a crash leaves
 * credentials on disk for a session that no longer exists. Swept at startup
 * rather than on exit, because a session that is killed never gets to clean up
 * after itself, and that is exactly when one is left behind.
 */
export function sweepDeadSessionDirs(c: PathCtx = {}, options: SweepOptions = {}): string[] {
  const isAlive = options.isAlive ?? processIsAlive;
  const root = sessionsRoot(c);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return []; // nothing has run yet
  }

  const removed: string[] = [];
  for (const name of entries) {
    const pid = pidOfSessionDir(name);
    if (pid === null || pid === options.keepPid || isAlive(pid)) continue;
    const dir = path.join(root, name);
    // Before the delete, not after: a session killed before it could hand its
    // changes back still holds them, and so might an edit to the user's memory.
    returnSessionChanges(dir, c);
    // Kept for the next sweep when the only copy of an edit could not be saved.
    if (!returnSharedUserFiles(dir, c)) continue;
    if (removeSessionDir(dir)) removed.push(name);
  }
  return removed;
}

/**
 * Clear out the directory a starting session is about to use, when a DEAD
 * process left it there.
 *
 * Session directories are named by pid, and pids are reused. A session that
 * finds its own directory already there found another process's, which the
 * sweep cannot tell, because the pid it belongs to is alive again: it is this
 * one. Taken over as found, the new session would inherit that process's
 * conversation and the prompt it armed for its swaps. Its changes are handed
 * back first, exactly as the sweep does for any other dead session.
 */
export function retireLeftoverSessionDir(dir: string, c: PathCtx = {}): boolean {
  if (!existsSync(dir)) return false;
  returnSessionChanges(dir, c);
  // An edit that could be neither handed back nor kept aside (a failed write
  // AND a failed copy: a full disk) exists only in here. The folder stays, and
  // this session does not start in it, rather than take it over or clear it.
  if (!returnSharedUserFiles(dir, c)) {
    throw new CasError(
      `ccx: the session that last used ${dir} left an edit to your CLAUDE.md or keybindings.json that could not be saved, and it is still in that folder. Free some disk space and start again.`,
    );
  }
  return removeSessionDir(dir);
}

/**
 * Delete one session directory without ever deleting through a link.
 *
 * `projects` inside a session directory is a junction to the user's real
 * `~/.claude/projects`, which holds every transcript and project memory they
 * have. A recursive delete that walked into it would take all of that with it,
 * so every link is unlinked first and the recursive delete only ever sees plain
 * files. This is the one operation in here that could destroy something
 * irreplaceable, which is why it does not rely on the delete being link-aware.
 */
export function removeSessionDir(dir: string): boolean {
  let credential: string | undefined;
  try {
    for (const entry of readdirSync(dir)) {
      const child = path.join(dir, entry);
      if (isLink(child)) unlinkSync(child);
    }
  } catch {
    // Unreadable or already gone. Fall through: if anything is still linked the
    // delete below is skipped by the catch, and the next sweep tries again.
  }
  try {
    if (!existsSync(dir)) {
      clearCredential(dir);
      return false;
    }
    try {
      credential = readCredential(credentialPath(dir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
    }
    clearCredential(dir);
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    if (credential !== undefined) {
      try {
        // Recreates an owner-only fallback if cleanup already removed Keychain.
        writeCredential(credentialPath(dir), credential);
      } catch {
        // The directory or credential store may still be inaccessible.
      }
    }
    // The sweep discovers retry paths through directory entries. Keep an empty
    // owner-only directory even if it was already absent when cleanup failed.
    // Do not report a retryable failure unless that path has been preserved.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return false; // busy (a live session, despite the pid check); next start retries
  }
}
