import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { writeSecretFile } from '../util/secret-file.js';
import {
  readKeychainCredential,
  writeKeychainCredential,
  deleteKeychainCredential,
} from './keychain.js';

export const CREDENTIALS_FILE = '.credentials.json';

/** Snapshots and previous generations are ordinary owner-only files. */
function isLiveCredential(file: string): boolean {
  return path.basename(file) === CREDENTIALS_FILE;
}

/** Match Claude's precedence: a profile's Keychain entry wins over its fallback file. */
export function readCredential(file: string): string {
  if (isLiveCredential(file)) {
    const stored = readKeychainCredential(path.dirname(file));
    if (stored !== null) return stored;
  }
  return readFileSync(file, 'utf8');
}

/** Only a missing item/file means absent; callers must report access failures. */
export function hasCredential(file: string): boolean {
  try {
    readCredential(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
    throw error;
  }
}

/** Update the store Claude actually reads; never hide a Keychain failure behind a stale file. */
export function writeCredential(file: string, text: string): void {
  if (isLiveCredential(file) && readKeychainCredential(path.dirname(file)) !== null) {
    writeKeychainCredential(path.dirname(file), text);
  } else {
    // Linux/Windows, existing macOS file fallbacks, and new session snapshots.
    writeSecretFile(file, text);
  }
}

export function copyCredential(source: string, destination: string): void {
  writeCredential(destination, readCredential(source));
}

/** Remove both stores so deleting Keychain cannot resurrect a stale file login. */
export function removeCredential(file: string): void {
  const errors: unknown[] = [];
  try {
    if (isLiveCredential(file)) deleteKeychainCredential(path.dirname(file));
  } catch (error) {
    errors.push(error);
  }
  // A locked Keychain must not prevent removal of a stale fallback file.
  try {
    rmSync(file, { force: true });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Could not remove Keychain and file credentials');
  }
}
