import path from 'node:path';
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

/** Pin (or clear, with null) the active account. */
export function setActive(name: string | null, c: PathCtx = {}): void {
  writeJsonFile(activeFilePath(c), { active: name });
}
