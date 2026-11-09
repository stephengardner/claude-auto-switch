import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { writeSecretFile } from '../util/secret-file.js';
import { call, runBlocking, type Steps } from '../util/steps.js';
import { CREDENTIALS_LOCK_DIR, lockDirSteps } from '../claude/locks.js';
import { keychainBlocking, type KeychainIo } from './keychain-view.js';
import { DEFAULT_LOGIN, defaultLoginFolder } from './default-login-item.js';

export const CREDENTIALS_FILE = '.credentials.json';

/** Snapshots and previous generations are ordinary owner-only files. */
function isLiveCredential(file: string): boolean {
  return path.basename(file) === CREDENTIALS_FILE;
}

/**
 * Marks the profile whose Claude login sits in Claude's default login (chat
 * mode, default-login.ts). The rest of the profile's saved login waits in it,
 * under `kept`, until the login goes home: the MCP sign-ins folders parked
 * there among it, since the default login keeps the ones its own chats hold.
 */
export const DEFAULT_LOGIN_MARKER = '.ccx-default-login';

export function holdsDefaultLogin(dir: string): boolean {
  return existsSync(path.join(dir, DEFAULT_LOGIN_MARKER));
}

function asObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A holder's marker, `{ at, kept? }`; {} when there is none or it does not parse. */
export function readDefaultLoginMarker(dir: string): Record<string, unknown> {
  try {
    return asObject(readFileSync(path.join(dir, DEFAULT_LOGIN_MARKER), 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/** What a holder keeps aside of its saved login: all of it but the Claude login. */
export function keptAside(marker: Record<string, unknown>): Record<string, unknown> {
  const kept = marker.kept;
  if (typeof kept !== 'object' || kept === null || Array.isArray(kept)) return {};
  const rest = { ...(kept as Record<string, unknown>) };
  delete rest.claudeAiOauth;
  return rest;
}

/** Owner-only, whole: it can hold MCP sign-ins. */
export function writeDefaultLoginMarker(dir: string, kept: Record<string, unknown>, at: number = Date.now()): void {
  writeSecretFile(path.join(dir, DEFAULT_LOGIN_MARKER), `${JSON.stringify({ at, kept })}\n`);
}

/**
 * A holder's saved login as ccx sees it: the Claude login in the default
 * login, never the default login's own MCP sign-ins (a live store's, which
 * ccx copies nowhere), with the rest kept aside in its marker. Null when it
 * holds neither.
 */
export function heldLoginView(defaultText: string | null, marker: Record<string, unknown>): string | null {
  const login = asObject(defaultText)?.claudeAiOauth;
  const kept = keptAside(marker);
  if (login === undefined && Object.keys(kept).length === 0) return null;
  return JSON.stringify({ ...(login !== undefined ? { claudeAiOauth: login } : {}), ...kept });
}

/** The lock Claude takes in ~/.claude to renew its default login. */
export function defaultLoginLock(): string {
  return path.join(defaultLoginFolder(), CREDENTIALS_LOCK_DIR);
}

function* readHeldSteps(dir: string, io: KeychainIo): Steps<string> {
  const view = heldLoginView(yield* call(() => io.read(DEFAULT_LOGIN)), readDefaultLoginMarker(dir));
  if (view === null) throw Object.assign(new Error('no login in the default login'), { code: 'ENOENT' });
  return view;
}

/**
 * Write a holder's saved login: its Claude login into the default login, every
 * other key there kept as it is (the chats' MCP sign-ins among them), and the
 * rest into its marker. Only under the lock Claude takes to renew the default
 * login, tried once, so a renewal of the chats' is never written over.
 */
function* writeHeldSteps(
  dir: string,
  text: string | ((current: string | null) => string),
  io: KeychainIo,
): Steps<void> {
  const lock = yield* lockDirSteps(defaultLoginLock(), { waitMs: 0 });
  if (!lock.held) {
    lock.release();
    throw new Error(
      lock.unusable
        ? `the lock of Claude's default login could not be created (${lock.unusable})`
        : "Claude is renewing its default login",
    );
  }
  try {
    const current = yield* call(() => io.read(DEFAULT_LOGIN));
    const marker = readDefaultLoginMarker(dir);
    const next = asObject(typeof text === 'string' ? text : text(heldLoginView(current, marker)));
    if (next === null) throw new Error('not a login that can be kept in the default login');
    const { claudeAiOauth: login, ...rest } = next;
    const base = asObject(current) ?? {};
    if (login !== undefined && !isDeepStrictEqual(login, base.claudeAiOauth)) {
      yield* call(() => io.write(DEFAULT_LOGIN, JSON.stringify({ ...base, claudeAiOauth: login })));
    }
    if (!isDeepStrictEqual(rest, keptAside(marker))) {
      writeDefaultLoginMarker(dir, rest, typeof marker.at === 'number' ? marker.at : Date.now());
    }
  } finally {
    lock.release();
  }
}

/**
 * Each operation here is written once, as steps (util/steps), and run either
 * way: blocking, as the plain names do, or on timers with keychainOnTimers,
 * for a running session, whose thread relays Claude's terminal.
 */

/**
 * Match Claude's precedence: a profile's Keychain entry wins over its fallback
 * file. A profile holding Claude's default login (chat mode) is read there.
 */
export function* readCredentialSteps(file: string, io: KeychainIo): Steps<string> {
  if (isLiveCredential(file)) {
    const dir = path.dirname(file);
    const stored = yield* call(() => io.read(dir));
    if (stored !== null) return stored;
    if (holdsDefaultLogin(dir)) return yield* readHeldSteps(dir, io);
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
  } else if (isLiveCredential(file) && holdsDefaultLogin(dir)) {
    yield* writeHeldSteps(dir, text, io);
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

/**
 * Remove both stores so deleting Keychain cannot resurrect a stale file login.
 * A profile holding the default login lets go of it; the login stays there.
 */
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
  if (isLiveCredential(file)) {
    try {
      rmSync(path.join(path.dirname(file), DEFAULT_LOGIN_MARKER), { force: true });
    } catch (error) {
      errors.push(error);
    }
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
