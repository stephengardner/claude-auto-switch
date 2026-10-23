import { existsSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { CREDENTIALS_LOCK_DIR, lockDirHeldHere } from '../claude/locks.js';
import {
  deleteKeychainCredential,
  deleteKeychainCredentialAsync,
  readKeychainCredential,
  readKeychainCredentialAsync,
  writeKeychainCredential,
  writeKeychainCredentialAsync,
} from './keychain.js';

/**
 * The Keychain items Claude keeps a folder's login in, as ccx reads and writes
 * them. Every read and write of one goes through here, never keychain.ts.
 *
 * Outside a running session this is keychain.ts as it is asked. While a session
 * runs Claude (watchKeychain), a read made on the thread that relays Claude's
 * terminal runs no `security` at all: it is answered with the item as last
 * read, and an item is read again, off that thread, only once its folder says
 * it may have changed.
 *
 * Why the folder says so. Claude 2.1.302 makes every change to its login store
 * (a renewal's save, /login, /logout) inside a lock it takes in the folder,
 * `.storage-write.lock`, a folder made with mkdir and removed with rmdir; a
 * renewal also holds `.oauth_refresh.lock` there for the whole renewal. Making
 * and removing either changes the folder's own modification time, the removal
 * coming after the write. Every write ccx makes changes it too (markFolder),
 * after the write. So an item read while no such lock of Claude's was in its
 * folder, from a folder that has not changed since, is the item as it is.
 *
 * An item that does not meet that is read again at the next look, as is one
 * read within SETTLE_MS of its folder changing, for a writer that changes the
 * folder just before writing the item (an older ccx keeps a copy of the login
 * it replaces in the folder first) or a file system that keeps times to the
 * second. And every item is read again at least every BACKSTOP_MS whatever its
 * folder says, for a writer that marks nothing at all (someone in Keychain
 * Access).
 *
 * Where this process holds a folder's login lock for work done synchronously,
 * the first read of that folder's item under it runs `security` as before,
 * since what that work decides may count on the item as it is: the lock keeps
 * Claude's renewals out from then on, and ccx's own writes come back here. Work
 * that waits in steps under a lock (lockDirSteps) reads with the async forms.
 */

/** Claude's locks around a change to its login store. */
const CLAUDE_WRITE_LOCKS = ['.storage-write.lock', CREDENTIALS_LOCK_DIR];
const SETTLE_MS = 2_000;
const BACKSTOP_MS = 60_000;
/** How soon an item that could not be read is tried again. */
const RETRY_FAILED_MS = 5_000;
/** An item nothing has asked for in this long is no longer looked after, unless it is pinned. */
const FORGET_MS = 120_000;

/** A folder as it was when its item was read: its time (null: no folder), and whether a write of Claude's was under way in it. */
interface FolderLook {
  changedAt: number | null;
  writing: boolean;
}

interface Item {
  /** False until a read has landed or a write been made: there is nothing to answer with yet. */
  known: boolean;
  value: string | null;
  failed: boolean;
  look: FolderLook;
  readStartedAt: number;
  /** What this process wrote itself, so the folder changing just before it says nothing about it. */
  ownWrite: boolean;
  /** This process's hold on the folder's login lock when the item was read or written, if it had one. */
  under: symbol | null;
  askedAt: number;
  /** Changed by every read that lands and every write, so a read started before either cannot land over it. */
  generation: number;
  reading: Promise<void> | null;
}

function lookAtFolder(dir: string): FolderLook {
  let changedAt: number | null;
  try {
    changedAt = statSync(dir).mtimeMs;
  } catch {
    changedAt = null;
  }
  const writing = CLAUDE_WRITE_LOCKS.some((name) => {
    const lock = path.join(dir, name);
    return lockDirHeldHere(lock) === null && existsSync(lock);
  });
  return { changedAt, writing };
}

/** Change a folder's time, so a session looking at it reads its item again. Never throws. */
function markFolder(dir: string): void {
  try {
    const now = new Date();
    utimesSync(dir, now, now);
  } catch {
    /* no folder there: nothing can be watching it */
  }
}

/** A read or write that landed, for the item it describes. */
interface Landed {
  value: string | null;
  failed: boolean;
  look: FolderLook;
  startedAt: number;
  ownWrite: boolean;
  under: symbol | null;
}

/** This process's hold on `dir`'s login lock now, if it has one. */
const holdOn = (dir: string): { hold: symbol; synchronous: boolean } | null =>
  lockDirHeldHere(path.join(dir, CREDENTIALS_LOCK_DIR));

export interface KeychainWatch {
  /** Read each of these folders' items off the thread, and keep it in step from then on; `pinned` ones are never let go. */
  watch(dirs: string[], options?: { pinned?: boolean }): Promise<void>;
  /** Look at every folder watched, and read again off the thread the items whose folders say they may have changed. Settles once those reads have. */
  look(): Promise<void>;
  stop(): void;
}

class Watch implements KeychainWatch {
  private readonly items = new Map<string, Item>();
  private readonly pinned = new Set<string>();
  private stopped = false;

  constructor(private readonly onStop: (watch: Watch) => void) {}

  watch(dirs: string[], options: { pinned?: boolean } = {}): Promise<void> {
    const reads: Promise<void>[] = [];
    for (const dir of dirs) {
      if (options.pinned) this.pinned.add(dir);
      const item = this.items.get(dir);
      if (item) item.askedAt = Date.now();
      else reads.push(this.readOffThread(dir));
    }
    return Promise.all(reads).then(() => undefined);
  }

  look(): Promise<void> {
    const now = Date.now();
    const reads: Promise<void>[] = [];
    for (const [dir, item] of this.items) {
      if (!this.pinned.has(dir) && now - item.askedAt >= FORGET_MS) {
        this.items.delete(dir);
        continue;
      }
      if (!item.reading && !this.current(dir, item, now)) reads.push(this.readOffThread(dir));
    }
    return Promise.all(reads).then(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    this.items.clear();
    this.onStop(this);
  }

  /** The item as a running session reads it on its thread (see the module comment). */
  read(dir: string): string | null {
    const now = Date.now();
    const item = this.items.get(dir);
    const held = holdOn(dir);
    if (!item || !item.known || (held?.synchronous && item.under !== held.hold)) return this.readOnThread(dir);
    item.askedAt = now;
    if (!item.reading && !this.current(dir, item, now)) void this.readOffThread(dir);
    if (item.failed) throw new Error('Could not read the profile login from macOS Keychain');
    return item.value;
  }

  record(dir: string, landed: Landed): void {
    if (this.stopped) return;
    const before = this.items.get(dir);
    this.items.set(dir, {
      known: true,
      value: landed.value,
      failed: landed.failed,
      look: landed.look,
      readStartedAt: landed.startedAt,
      ownWrite: landed.ownWrite,
      under: landed.under,
      askedAt: before?.askedAt ?? Date.now(),
      generation: (before?.generation ?? 0) + 1,
      reading: null,
    });
  }

  generationOf(dir: string): number {
    return this.items.get(dir)?.generation ?? 0;
  }

  private current(dir: string, item: Item, now: number): boolean {
    if (item.failed) return now - item.readStartedAt < RETRY_FAILED_MS;
    if (item.look.writing) return false;
    const settled =
      item.ownWrite || item.look.changedAt === null || item.readStartedAt - item.look.changedAt >= SETTLE_MS;
    if (!settled || now - item.readStartedAt >= BACKSTOP_MS) return false;
    const look = lookAtFolder(dir);
    return !look.writing && look.changedAt === item.look.changedAt;
  }

  private readOnThread(dir: string): string | null {
    const look = lookAtFolder(dir);
    const startedAt = Date.now();
    const under = holdOn(dir)?.hold ?? null;
    try {
      const value = readKeychainCredential(dir);
      this.record(dir, { value, failed: false, look, startedAt, ownWrite: false, under });
      return value;
    } catch (error) {
      this.record(dir, { value: null, failed: true, look, startedAt, ownWrite: false, under });
      throw error;
    }
  }

  private readOffThread(dir: string): Promise<void> {
    const look = lookAtFolder(dir);
    const startedAt = Date.now();
    const under = holdOn(dir)?.hold ?? null;
    const generation = this.generationOf(dir);
    const settle = (value: string | null, failed: boolean): void => {
      if (this.generationOf(dir) === generation) {
        this.record(dir, { value, failed, look, startedAt, ownWrite: false, under });
      }
    };
    // Begun inside a promise, so nothing it throws reaches the caller, a session's poll.
    const reading = Promise.resolve()
      .then(() => readKeychainCredentialAsync(dir))
      .then(
        (value) => settle(value, false),
        () => settle(null, true),
      );
    const item = this.items.get(dir);
    if (item) item.reading = reading;
    else {
      this.items.set(dir, {
        known: false,
        value: null,
        failed: false,
        look,
        readStartedAt: startedAt,
        ownWrite: false,
        under,
        askedAt: Date.now(),
        generation,
        reading,
      });
    }
    return reading;
  }
}

let active: Watch | null = null;

/**
 * From here until `stop`, answer this process's reads of folders' Keychain
 * items as a running session's (see the module comment). One at a time per
 * process: starting another stops the one before it.
 */
export function watchKeychain(): KeychainWatch {
  active?.stop();
  const watch = new Watch((stopped) => {
    if (active === stopped) active = null;
  });
  active = watch;
  return watch;
}

/** The login in `dir`'s Keychain item, or null when there is none; throws when it cannot be read. */
export function readKeychainItem(dir: string): string | null {
  return active ? active.read(dir) : readKeychainCredential(dir);
}

/** readKeychainItem as the item is now, with the thread free while `security` runs. */
export async function readKeychainItemAsync(dir: string): Promise<string | null> {
  const watch = active;
  const look = lookAtFolder(dir);
  const startedAt = Date.now();
  const under = holdOn(dir)?.hold ?? null;
  const generation = watch?.generationOf(dir) ?? 0;
  const landed = (value: string | null, failed: boolean): void => {
    if (watch?.generationOf(dir) === generation) {
      watch.record(dir, { value, failed, look, startedAt, ownWrite: false, under });
    }
  };
  try {
    const value = await readKeychainCredentialAsync(dir);
    landed(value, false);
    return value;
  } catch (error) {
    landed(null, true);
    throw error;
  }
}

function wrote(dir: string, value: string | null): void {
  markFolder(dir);
  active?.record(dir, {
    value,
    failed: false,
    look: lookAtFolder(dir),
    startedAt: Date.now(),
    ownWrite: true,
    under: holdOn(dir)?.hold ?? null,
  });
}

export function writeKeychainItem(dir: string, text: string): void {
  writeKeychainCredential(dir, text);
  wrote(dir, text.trim() || null);
}

export async function writeKeychainItemAsync(dir: string, text: string): Promise<void> {
  await writeKeychainCredentialAsync(dir, text);
  wrote(dir, text.trim() || null);
}

export function removeKeychainItem(dir: string): void {
  deleteKeychainCredential(dir);
  wrote(dir, null);
}

export async function removeKeychainItemAsync(dir: string): Promise<void> {
  await deleteKeychainCredentialAsync(dir);
  wrote(dir, null);
}

/** The Keychain as a step of some work (util/steps) reaches it: blocking, or on timers. */
export interface KeychainIo {
  read(dir: string): string | null | Promise<string | null>;
  write(dir: string, text: string): void | Promise<void>;
  remove(dir: string): void | Promise<void>;
}

export const keychainBlocking: KeychainIo = {
  read: readKeychainItem,
  write: writeKeychainItem,
  remove: removeKeychainItem,
};

export const keychainOnTimers: KeychainIo = {
  read: readKeychainItemAsync,
  write: writeKeychainItemAsync,
  remove: removeKeychainItemAsync,
};
