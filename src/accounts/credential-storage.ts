import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { writeSecretFile } from '../util/secret-file.js';
import { call, runBlocking, type Steps } from '../util/steps.js';
import { keychainBlocking, type KeychainIo } from './keychain-view.js';

export const CREDENTIALS_FILE = '.credentials.json';

/** Snapshots and previous generations are ordinary owner-only files. */
function isLiveCredential(file: string): boolean {
  return path.basename(file) === CREDENTIALS_FILE;
}

/**
 * Each operation here is written once, as steps (util/steps), and run either
 * way: blocking, as the plain names do, or on timers with keychainOnTimers,
 * for a running session, whose thread relays Claude's terminal.
 */

/** Match Claude's precedence: a profile's Keychain entry wins over its fallback file. */
export function* readCredentialSteps(file: string, io: KeychainIo): Steps<string> {
  if (isLiveCredential(file)) {
    const stored = yield* call(() => io.read(path.dirname(file)));
    if (stored !== null) return stored;
  }
  return readFileSync(file, 'utf8');
}

/** Only a missing item/file means absent; callers must report access failures. */
export function* hasCredentialSteps(file: string, io: KeychainIo): Steps<boolean> {
  try {
    yield* readCredentialSteps(file, io);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Update the store Claude actually reads; never hide a Keychain failure behind a stale file.
 * `text` may be a function of what that store holds, read just before the write (null when it holds nothing).
 */
export function* writeCredentialSteps(
  file: string,
  text: string | ((current: string | null) => string),
  io: KeychainIo,
): Steps<void> {
  const dir = path.dirname(file);
  const item = isLiveCredential(file) ? yield* call(() => io.read(dir)) : null;
  if (item !== null) {
    yield* call(() => io.write(dir, typeof text === 'string' ? text : text(item)));
  } else {
    // Linux/Windows, existing macOS file fallbacks, and new session snapshots.
    writeSecretFile(file, typeof text === 'string' ? text : text(readFileOrNull(file)));
  }
}

function readFileOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function* copyCredentialSteps(source: string, destination: string, io: KeychainIo): Steps<void> {
  const text = yield* readCredentialSteps(source, io);
  yield* writeCredentialSteps(destination, text, io);
}

/** Remove both stores so deleting Keychain cannot resurrect a stale file login. */
export function* removeCredentialSteps(file: string, io: KeychainIo): Steps<void> {
  const errors: unknown[] = [];
  try {
    if (isLiveCredential(file)) yield* call(() => io.remove(path.dirname(file)));
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

export function readCredential(file: string): string {
  return runBlocking(readCredentialSteps(file, keychainBlocking));
}

export function hasCredential(file: string): boolean {
  return runBlocking(hasCredentialSteps(file, keychainBlocking));
}

export function writeCredential(file: string, text: string): void {
  runBlocking(writeCredentialSteps(file, text, keychainBlocking));
}

export function copyCredential(source: string, destination: string): void {
  runBlocking(copyCredentialSteps(source, destination, keychainBlocking));
}

export function removeCredential(file: string): void {
  runBlocking(removeCredentialSteps(file, keychainBlocking));
}
