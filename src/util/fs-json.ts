import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
 */
export function writeJsonFile(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}
