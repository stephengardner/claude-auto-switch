import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { CREDENTIALS_LOCK_DIR, lockDirSteps } from '../claude/locks.js';
import { writeSecretFile } from '../util/secret-file.js';
import { runBlocking, runOnTimers, type Steps } from '../util/steps.js';
import { thrownReason } from '../util/thrown-reason.js';
import { readCredentialSteps, writeCredentialSteps } from './credential-storage.js';
import { credentialPath, loginTextFingerprint, usableLoginText } from './credential-vault.js';
import { keychainBlocking, keychainOnTimers, type KeychainIo } from './keychain-view.js';
import { mergeMcpLogins } from './mcp-logins.js';

/**
 * A renewed login, kept in its folder from the moment Anthropic issues it
 * until it is saved where Claude reads it.
 *
 * A renewal retires the login it renews, so a save that failed after one (a
 * Keychain that refused the write, or cut it short) left the folder holding a
 * login that no longer works and nothing holding the one that does. Kept here
 * first, it is saved by the next look at the folder instead
 * (takeUpKeptRenewalSteps).
 *
 * The file is a record around the login, not a login, under a name nothing
 * that takes a folder's login files by name knows: nothing reads, copies or
 * hands it back as one.
 */
export const KEPT_RENEWAL_FILE = '.credentials.renewed.json';

interface KeptRenewal {
  /** The login the renewal retired, as loginTextFingerprint gives it. */
  retired: string | null;
  /** The renewed login, as it was to be saved. */
  login: string;
}

export function keptRenewalPath(dir: string): string {
  return path.join(dir, KEPT_RENEWAL_FILE);
}

export function hasKeptRenewal(dir: string): boolean {
  return existsSync(keptRenewalPath(dir));
}

/** Keep `login`, a renewal of the login `retired` names, in `dir`. False when it could not be written. */
export function keepRenewal(dir: string, login: string, retired: string | null): boolean {
  try {
    writeSecretFile(keptRenewalPath(dir), `${JSON.stringify({ retired, login } satisfies KeptRenewal)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Never throws: one left behind is found saved by the next look, and removed then. */
export function forgetKeptRenewal(dir: string): void {
  try {
    rmSync(keptRenewalPath(dir), { force: true });
  } catch {
    /* see above */
  }
}

function readKept(dir: string): KeptRenewal | null {
  try {
    const parsed = JSON.parse(readFileSync(keptRenewalPath(dir), 'utf8')) as Partial<KeptRenewal> | null;
    if (typeof parsed?.login !== 'string' || !usableLoginText(parsed.login)) return null;
    return { retired: typeof parsed.retired === 'string' ? parsed.retired : null, login: parsed.login };
  } catch {
    return null;
  }
}

function expiresAt(text: string): number {
  try {
    const at = (JSON.parse(text) as { claudeAiOauth?: { expiresAt?: unknown } }).claudeAiOauth?.expiresAt;
    return typeof at === 'number' ? at : 0;
  } catch {
    return 0;
  }
}

/**
 * Whether the kept renewal is newer than `stored`, what the folder holds now:
 * when that holds no working login (none, signed out, or cut short), or holds
 * the one the renewal retired, or another that expires sooner. A sign-in
 * since, a renewal made another way, or a login with no expiry is not older.
 */
function newerThanStored(kept: KeptRenewal, stored: string | null): boolean {
  if (stored === null || !usableLoginText(stored)) return true;
  if (kept.retired !== null && loginTextFingerprint(stored) === kept.retired) return true;
  const storedExpiry = expiresAt(stored);
  return storedExpiry > 0 && expiresAt(kept.login) > storedExpiry;
}

export type TakeUp =
  | { state: 'none' }
  /** Saved where Claude reads it, and the kept file removed. */
  | { state: 'saved'; retired: string | null }
  /** The folder holds a newer login; the kept one was removed. */
  | { state: 'stale' }
  /** The login's lock is held, or the kept renewal or the stored login could not be read or written: tried again at the next look. */
  | { state: 'later'; detail: string };

/**
 * Save the renewal kept in `dir` where Claude reads it, when it is newer than
 * what is stored there, under the lock Claude and every renewal take. A store
 * that holds a login keeps its own MCP sign-ins, as one a move writes into
 * does; one that holds none gets the renewal whole, its sign-ins included,
 * since they were this folder's own.
 */
export function* takeUpKeptRenewalSteps(dir: string, io: KeychainIo, lockWaitMs?: number): Steps<TakeUp> {
  if (!hasKeptRenewal(dir)) return { state: 'none' };
  const lock = yield* lockDirSteps(path.join(dir, CREDENTIALS_LOCK_DIR), {
    ...(lockWaitMs !== undefined ? { waitMs: lockWaitMs } : {}),
  });
  if (lock.unusable) return { state: 'later', detail: `its lock folder could not be created (${lock.unusable})` };
  if (!lock.held) return { state: 'later', detail: 'something else is renewing this login' };
  try {
    const kept = readKept(dir);
    if (kept === null) {
      return hasKeptRenewal(dir) ? { state: 'later', detail: 'the kept renewal could not be read' } : { state: 'none' };
    }
    const file = credentialPath(dir);
    let stored: string | null;
    try {
      stored = yield* readCredentialSteps(file, io);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        return { state: 'later', detail: `the stored login could not be read (${thrownReason(error)})` };
      }
      stored = null;
    }
    if (!newerThanStored(kept, stored)) {
      forgetKeptRenewal(dir);
      return { state: 'stale' };
    }
    try {
      yield* writeCredentialSteps(file, (current) => mergeMcpLogins(kept.login, current, 'folder'), io);
    } catch (error) {
      return { state: 'later', detail: `it could not be saved (${thrownReason(error)})` };
    }
    forgetKeptRenewal(dir);
    return { state: 'saved', retired: kept.retired };
  } finally {
    lock.release();
  }
}

export function takeUpKeptRenewal(dir: string, lockWaitMs?: number): Promise<TakeUp> {
  return runOnTimers(takeUpKeptRenewalSteps(dir, keychainOnTimers, lockWaitMs));
}

export function takeUpKeptRenewalBlocking(dir: string, lockWaitMs?: number): TakeUp {
  return runBlocking(takeUpKeptRenewalSteps(dir, keychainBlocking, lockWaitMs));
}

/** Whether `dir` keeps a renewal that a look would save: for a report, which changes nothing. */
export function keptRenewalWaiting(dir: string): boolean {
  if (!hasKeptRenewal(dir)) return false;
  const kept = readKept(dir);
  if (kept === null) return true;
  let stored: string | null;
  try {
    stored = runBlocking(readCredentialSteps(credentialPath(dir), keychainBlocking));
  } catch {
    stored = null;
  }
  return newerThanStored(kept, stored);
}
