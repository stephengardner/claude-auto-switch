import path from 'node:path';
import { z } from 'zod';
import { configHome, type PathCtx } from '../config/paths.js';
import { readJsonFile, writeJsonFile } from '../util/fs-json.js';

/**
 * Which stored logins the token endpoint has told us are finished, kept on disk.
 *
 * The in-process memory in dead-login-memo.ts stops a running session asking the
 * same dead login again. It cannot answer the question asked here, which a FRESH
 * process has to answer before it does anything: nothing has been tried yet, so
 * there is nothing in memory.
 *
 * That is not a reversal of keeping the retry memory in the process. The two
 * answer different questions: "have I already asked this" is about one process's
 * own traffic, and "is this login known finished" is about what to say and do
 * before any traffic exists.
 *
 * Keyed by the credential's CONTENT, never by account name, so signing in again
 * clears it automatically: a new login is a different file, so a different key,
 * and no stale note can hold down an account that now works. A fingerprint is a
 * hash; no token is ever stored here.
 *
 * `ctx` is REQUIRED on every function on purpose. An earlier draft defaulted it
 * to the real config home, and the first test run that forgot to pass one wrote
 * into the operator's live state. A default that resolves to production is a
 * loaded gun pointed at production.
 */

const StoreSchema = z.object({
  /** credential fingerprint -> when it was refused, and why. */
  refused: z.record(z.string(), z.object({ at: z.number(), detail: z.string() })),
});

type Store = z.infer<typeof StoreSchema>;

const FILENAME = 'dead-logins.json';
/**
 * How many refusals to keep. This only grows when a DIFFERENT credential is
 * refused, so it is generous: it bounds a file that would otherwise gain an
 * entry per sign-in over the life of an install.
 */
const MAX_ENTRIES = 50;

function storePath(c: PathCtx): string {
  return path.join(configHome(c), FILENAME);
}

function load(c: PathCtx): Store {
  return readJsonFile(storePath(c), StoreSchema) ?? { refused: {} };
}

/** Is this exact credential known to have been refused for good? */
export function loginIsKnownDead(fingerprint: string | null, c: PathCtx): boolean {
  if (!fingerprint) return false;
  try {
    return load(c).refused[fingerprint] !== undefined;
  } catch {
    // Unreadable state must never hold an account down: not knowing is not the
    // same as knowing it is dead, and the wrong answer here costs a login that
    // works.
    return false;
  }
}

/** Why this credential was refused, for saying so once. */
export function deadLoginReason(fingerprint: string | null, c: PathCtx): string | undefined {
  if (!fingerprint) return undefined;
  try {
    return load(c).refused[fingerprint]?.detail;
  } catch {
    return undefined;
  }
}

/** Record that this credential cannot be renewed, with the reason and when. */
export function rememberDeadLogin(
  fingerprint: string | null,
  detail: string,
  c: PathCtx,
  now: number = Date.now(),
): void {
  if (!fingerprint) return;
  try {
    const store = load(c);
    store.refused[fingerprint] = { at: now, detail };
    const entries = Object.entries(store.refused);
    if (entries.length > MAX_ENTRIES) {
      // Oldest first, so the ones still being hit survive.
      entries.sort((a, b) => a[1].at - b[1].at);
      store.refused = Object.fromEntries(entries.slice(-MAX_ENTRIES));
    }
    writeJsonFile(storePath(c), store);
  } catch {
    /* the note is an optimisation; failing to write it must not break a swap */
  }
}

/** Forget one credential, for when it works again. */
export function forgetDeadLogin(fingerprint: string | null, c: PathCtx): void {
  if (!fingerprint) return;
  try {
    const store = load(c);
    if (store.refused[fingerprint] === undefined) return;
    delete store.refused[fingerprint];
    writeJsonFile(storePath(c), store);
  } catch {
    /* best effort */
  }
}
