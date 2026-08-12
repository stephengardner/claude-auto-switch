import { copyFileSync, existsSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { configHome, type PathCtx } from '../config/paths.js';
import { isLink } from '../daemon/junction.js';

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
 * Where session settings are kept BETWEEN sessions.
 *
 * The model pin lives in the session directory, because that is the config
 * directory Claude writes to when you use /model. A directory per session would
 * therefore forget the pin every time, silently putting you back on whatever
 * the default is, so it is carried out here as a session ends and back in as the
 * next one starts.
 */
export function keptSettingsPath(c: PathCtx = {}): string {
  return path.join(configHome(c), 'session-settings.json');
}

/**
 * Give a fresh session directory the settings the last one ended with.
 *
 * Falls back to the pre-split single directory, which is where the pin lives
 * for anyone upgrading: without that, the first session after the change starts
 * on a different model than the one they left running.
 */
export function seedFromKeptSettings(sessionDir: string, c: PathCtx = {}): boolean {
  const dest = path.join(sessionDir, 'settings.json');
  if (existsSync(dest)) return false;
  const sources = [keptSettingsPath(c), path.join(configHome(c), 'session', 'settings.json')];
  for (const source of sources) {
    try {
      if (!existsSync(source)) continue;
      copyFileSync(source, dest);
      return true;
    } catch {
      /* try the next source */
    }
  }
  return false;
}

/**
 * Carry a finished session's settings out before its directory is deleted.
 *
 * Newest wins, so sweeping several dead sessions at once cannot let the oldest
 * of them overwrite a pin set later.
 */
export function preserveSettings(sessionDir: string, c: PathCtx = {}): void {
  const from = path.join(sessionDir, 'settings.json');
  const to = keptSettingsPath(c);
  try {
    if (!existsSync(from)) return;
    if (existsSync(to) && statSync(to).mtimeMs >= statSync(from).mtimeMs) return;
    copyFileSync(from, to);
  } catch {
    /* a forgotten pin is an annoyance; throwing here would block the sweep */
  }
}

/** Default liveness check: signal 0 tests for the process without touching it. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
    // Before the delete, not after: the settings go with the directory.
    preserveSettings(dir, c);
    if (removeSessionDir(dir)) removed.push(name);
  }
  return removed;
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
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false; // busy (a live session, despite the pid check); next start retries
  }
}
