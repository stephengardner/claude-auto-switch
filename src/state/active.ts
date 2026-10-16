import path from 'node:path';
import { statSync } from 'node:fs';
import { z } from 'zod';
import { configHome, type PathCtx } from '../config/paths.js';
import { readJsonFile, writeJsonFile } from '../util/fs-json.js';

const ActiveSchema = z.object({ active: z.string().nullable() });
const FILENAME = 'active.json';

function activeFilePath(c: PathCtx = {}): string {
  const platform = c.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.join(configHome(c), FILENAME);
}

/** The manually pinned active account name, or null if unset. */
export function getActive(c: PathCtx = {}): string | null {
  return readJsonFile(activeFilePath(c), ActiveSchema)?.active ?? null;
}

/**
 * Pin (or clear, with null) the active account.
 *
 * Written only when it changes. Every session sets the account it starts on,
 * which is nearly always the one already active, and rewriting the file each
 * time would make its time say "a session started" rather than "the active
 * account changed" (see activeSince).
 */
export function setActive(name: string | null, c: PathCtx = {}): void {
  let stored: string | null | undefined;
  try {
    stored = getActive(c);
  } catch {
    stored = undefined; // a file that does not load is replaced
  }
  if (stored === name) return;
  writeJsonFile(activeFilePath(c), { active: name });
}

/**
 * When the active account last changed, or null when it never has been set.
 * For something that starts up later and needs to know how long the account
 * in use has been in use, rather than assume it began when it looked.
 */
export function activeSince(c: PathCtx = {}): number | null {
  try {
    return statSync(activeFilePath(c)).mtimeMs;
  } catch {
    return null;
  }
}
