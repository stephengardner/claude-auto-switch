import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { replaceFileSync } from './replace-file.js';
import type { ZodTypeAny, TypeOf } from 'zod';
import { ConfigError } from './errors.js';

/**
 * Read and validate a JSON file. Returns undefined when the file is absent.
 * Generic over the schema so the return type is the schema's OUTPUT type (with
 * zod defaults applied), not its input type. A malformed or invalid file throws
 * a typed ConfigError (which the CLI renders cleanly) instead of a raw crash.
 */
export function readJsonFile<S extends ZodTypeAny>(file: string, schema: S): TypeOf<S> | undefined {
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`could not parse ${file}: ${(err as Error).message}`);
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`invalid data in ${file}: ${result.error.issues[0]?.message ?? 'schema mismatch'}`);
  }
  return result.data as TypeOf<S>;
}

/**
 * Atomically write JSON owner-only: write a unique temp file then rename over the
 * target, so a crash mid-write never leaves a half-written file, concurrent
 * writers do not collide on the temp path, and the bytes are never world-readable.
 *
 * A failed write takes its temp file with it. It used to stay behind, one per
 * lost write, for as long as the folder existed.
 */
export function writeJsonFile(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    replaceFileSync(tmp, file);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the caller needs the real failure, not this one */
    }
    throw error;
  }
}

/** What each of ccx's atomic writers names its temp file. */
const TEMP_NAMES = [
  /\.json\.\d+\.[0-9a-z]+\.tmp$/, // writeJsonFile
  /^\..+\.ccx-\d+-\d+\.tmp$/, // writeFileAtomic
  /^\..+\.\d+\.[0-9a-z]+\.tmp$/, // secret files
];

/**
 * Remove temp files a writer abandoned in `dir`, returning how many.
 *
 * A temp file exists for milliseconds; one that is minutes old was left by a
 * write that failed or a process that died mid-write, and nothing will ever
 * use it. Only ccx's own temp names are touched, and only past `maxAgeMs`, so
 * a write in progress right now is never pulled out from under its writer.
 */
export function sweepAbandonedTemps(dir: string, maxAgeMs = 10 * 60_000, now = Date.now()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!TEMP_NAMES.some((pattern) => pattern.test(name))) continue;
    const full = path.join(dir, name);
    try {
      const stat = statSync(full);
      if (!stat.isFile() || now - stat.mtimeMs < maxAgeMs) continue;
      rmSync(full, { force: true });
      removed++;
    } catch {
      /* gone already, or busy: the next sweep gets it */
    }
  }
  return removed;
}
