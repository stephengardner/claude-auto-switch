import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  readKeychainItem,
  readKeychainItemAsync,
  removeKeychainItem,
  watchKeychain,
  writeKeychainItem,
  writeKeychainItemAsync,
  type KeychainWatch,
} from './keychain-view.js';
import { acquireLockDir, CREDENTIALS_LOCK_DIR, lockDirSteps } from '../claude/locks.js';
import { runOnTimers } from '../util/steps.js';

/**
 * `security` is a stand-in here: the Keychain is a map, and every call is
 * counted by how it was made, blocking the thread or off it.
 */
const fake = vi.hoisted(() => ({
  items: new Map<string, string>(),
  calls: [] as Array<{ dir: string; how: 'blocking' | 'off' }>,
  failing: new Set<string>(),
  /** While set, a read off the thread sees the item as it was when it began, and answers only once this settles. */
  gate: null as Promise<void> | null,
}));
vi.mock('./keychain.js', () => {
  const answer = (dir: string, how: 'blocking' | 'off'): string | null => {
    fake.calls.push({ dir, how });
    if (fake.failing.has(dir)) throw new Error('Could not read the profile login from macOS Keychain');
    return fake.items.get(dir) ?? null;
  };
  return {
    readKeychainCredential: (dir: string) => answer(dir, 'blocking'),
    readKeychainCredentialAsync: async (dir: string) => {
      const value = answer(dir, 'off');
      if (fake.gate) await fake.gate;
      return value;
    },
    writeKeychainCredential: (dir: string, text: string) => {
      fake.calls.push({ dir, how: 'blocking' });
      fake.items.set(dir, text.trim());
    },
    writeKeychainCredentialAsync: async (dir: string, text: string) => {
      fake.calls.push({ dir, how: 'off' });
      fake.items.set(dir, text.trim());
    },
    deleteKeychainCredential: (dir: string) => {
      fake.calls.push({ dir, how: 'blocking' });
      fake.items.delete(dir);
    },
    deleteKeychainCredentialAsync: async (dir: string) => {
      fake.calls.push({ dir, how: 'off' });
      fake.items.delete(dir);
    },
  };
});

const blocking = (): number => fake.calls.filter((c) => c.how === 'blocking').length;
const off = (): number => fake.calls.filter((c) => c.how === 'off').length;

/** A folder last changed a while ago, so nothing about it is still settling. */
function folder(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-kcview-'));
  age(dir);
  return dir;
}
function age(dir: string, msAgo = 10_000): void {
  const then = new Date(Date.now() - msAgo);
  utimesSync(dir, then, then);
}

let watch: KeychainWatch | null = null;
afterEach(() => {
  watch?.stop();
  watch = null;
  fake.items.clear();
  fake.calls.length = 0;
  fake.failing.clear();
  fake.gate = null;
  vi.useRealTimers();
});

describe('the Keychain outside a running session', () => {
  it('is read as it is asked, by `security`', () => {
    const dir = folder();
    fake.items.set(dir, 'login-1');
    expect(readKeychainItem(dir)).toBe('login-1');
    expect(readKeychainItem(dir)).toBe('login-1');
    expect(blocking()).toBe(2);
  });
});

describe('the Keychain while a session runs Claude', () => {
  it('answers a read with the item as last read, running no `security` on the thread', async () => {
    const dir = folder();
    fake.items.set(dir, 'login-1');
    watch = watchKeychain();
    await watch.watch([dir]);
    expect(off()).toBe(1);
    for (let i = 0; i < 10; i++) expect(readKeychainItem(dir)).toBe('login-1');
    await watch.look();
    expect(blocking()).toBe(0);
    expect(off()).toBe(1);
  });

  it('reads an item again, off the thread, once its folder has changed', async () => {
    const dir = folder();
    fake.items.set(dir, 'login-1');
    watch = watchKeychain();
    await watch.watch([dir]);
    // As Claude saves a renewal: under its lock in the folder, which changes the folder.
    mkdirSync(path.join(dir, '.storage-write.lock'));
    fake.items.set(dir, 'login-2');
    rmdirSync(path.join(dir, '.storage-write.lock'));
    await watch.look();
    expect(off()).toBe(2);
    expect(readKeychainItem(dir)).toBe('login-2');
    expect(blocking()).toBe(0);
  });

  it('reads it again while a write of Claude was under way when it was read', async () => {
    const dir = folder();
    mkdirSync(path.join(dir, CREDENTIALS_LOCK_DIR));
    age(dir);
    fake.items.set(dir, 'login-1');
    watch = watchKeychain();
    await watch.watch([dir]);
    // The folder has not changed since, but the renewal was still going on.
    await watch.look();
    expect(off()).toBe(2);
    fake.items.set(dir, 'login-2');
    rmdirSync(path.join(dir, CREDENTIALS_LOCK_DIR));
    await watch.look();
    expect(readKeychainItem(dir)).toBe('login-2');
    expect(blocking()).toBe(0);
  });

  it('leaves alone an item whose folder has not changed and had no write under way', async () => {
    const dir = folder();
    fake.items.set(dir, 'login-1');
    watch = watchKeychain();
    await watch.watch([dir]);
    for (let i = 0; i < 5; i++) await watch.look();
    expect(off()).toBe(1);
  });

  it('reads an item again until its folder has been still for a while', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-kcview-'));
    // Changed just now: a writer that changes the folder before the item may not have written it yet.
    fake.items.set(dir, 'login-1');
    watch = watchKeychain();
    await watch.watch([dir]);
    await watch.look();
    expect(off()).toBe(2);
    age(dir);
    await watch.look();
    expect(off()).toBe(3);
    await watch.look();
    expect(off()).toBe(3);
  });

  it('reads every item again at least once a minute, whatever its folder says', async () => {
    const dir = folder();
    fake.items.set(dir, 'login-1');
    watch = watchKeychain();
    await watch.watch([dir], { pinned: true });
    vi.useFakeTimers({ now: Date.now() + 59_000, toFake: ['Date'] });
    await watch.look();
    expect(off()).toBe(1);
    vi.setSystemTime(Date.now() + 2_000);
    await watch.look();
    expect(off()).toBe(2);
  });

  it('says a read failed as `security` did, and tries it again after a while rather than at every look', async () => {
    const dir = folder();
    fake.failing.add(dir);
    watch = watchKeychain();
    await watch.watch([dir]);
    expect(() => readKeychainItem(dir)).toThrow('Could not read the profile login from macOS Keychain');
    await watch.look();
    expect(off()).toBe(1);
    fake.failing.delete(dir);
    fake.items.set(dir, 'login-1');
    vi.useFakeTimers({ now: Date.now() + 6_000, toFake: ['Date'] });
    await watch.look();
    expect(readKeychainItem(dir)).toBe('login-1');
    expect(blocking()).toBe(0);
  });

  it('answers with what this process wrote, and changes the folder so others read it again', async () => {
    const dir = folder();
    const before = statSync(dir).mtimeMs;
    fake.items.set(dir, 'login-1');
    watch = watchKeychain();
    await watch.watch([dir]);
    writeKeychainItem(dir, 'login-2\n');
    expect(statSync(dir).mtimeMs).toBeGreaterThan(before);
    const calls = fake.calls.length;
    expect(readKeychainItem(dir)).toBe('login-2');
    await watch.look();
    expect(fake.calls.length).toBe(calls);
    removeKeychainItem(dir);
    expect(readKeychainItem(dir)).toBeNull();
  });

  it('never lets a read started before a write land over it', async () => {
    const dir = folder();
    fake.items.set(dir, 'login-1');
    watch = watchKeychain();
    await watch.watch([dir]);
    // The read sees the item as it was, and only lands after the write.
    let open = (): void => {};
    fake.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const stale = readKeychainItemAsync(dir);
    await writeKeychainItemAsync(dir, 'login-2');
    open();
    expect(await stale).toBe('login-1');
    expect(readKeychainItem(dir)).toBe('login-2');
  });

  it('reads an item never read before as `security` would, once, and keeps it after that', async () => {
    const dir = folder();
    fake.items.set(dir, 'login-1');
    watch = watchKeychain();
    expect(readKeychainItem(dir)).toBe('login-1');
    expect(readKeychainItem(dir)).toBe('login-1');
    expect(blocking()).toBe(1);
  });

  it('reads an item afresh once under a lock this process holds for work done synchronously', async () => {
    const dir = folder();
    fake.items.set(dir, 'login-1');
    watch = watchKeychain();
    await watch.watch([dir]);
    const lock = acquireLockDir(path.join(dir, CREDENTIALS_LOCK_DIR), { waitMs: 0 });
    try {
      expect(lock.held).toBe(true);
      expect(readKeychainItem(dir)).toBe('login-1');
      expect(readKeychainItem(dir)).toBe('login-1');
      expect(blocking()).toBe(1);
    } finally {
      lock.release();
    }
  });

  it('runs no `security` on the thread for a lock held by work that goes on in steps', async () => {
    const dir = folder();
    fake.items.set(dir, 'login-1');
    watch = watchKeychain();
    await watch.watch([dir]);
    const read = await runOnTimers(
      (function* () {
        const lock = yield* lockDirSteps(path.join(dir, CREDENTIALS_LOCK_DIR), { waitMs: 0 });
        try {
          return readKeychainItem(dir);
        } finally {
          lock.release();
        }
      })(),
    );
    expect(read).toBe('login-1');
    expect(blocking()).toBe(0);
  });

  it('does not take a lock of its own in a folder for a write of Claude under way there', async () => {
    const dir = folder();
    fake.items.set(dir, 'login-1');
    watch = watchKeychain();
    const lock = acquireLockDir(path.join(dir, CREDENTIALS_LOCK_DIR), { waitMs: 0 });
    try {
      age(dir);
      await watch.watch([dir]);
      await watch.look();
      await watch.look();
      expect(off()).toBe(1);
    } finally {
      lock.release();
    }
  });

  it('lets go of an item nothing has asked for in two minutes, unless it is pinned', async () => {
    const kept = folder();
    const dropped = folder();
    watch = watchKeychain();
    await watch.watch([kept], { pinned: true });
    await watch.watch([dropped]);
    vi.useFakeTimers({ now: Date.now() + 121_000, toFake: ['Date'] });
    await watch.look();
    // Both read again once a minute has passed; only the pinned one once forgotten.
    expect(fake.calls.filter((c) => c.how === 'off').map((c) => c.dir)).toEqual([kept, dropped, kept]);
  });

  it('goes back to reading as it is asked once stopped', async () => {
    const dir = folder();
    fake.items.set(dir, 'login-1');
    watch = watchKeychain();
    await watch.watch([dir]);
    watch.stop();
    watch = null;
    expect(readKeychainItem(dir)).toBe('login-1');
    expect(blocking()).toBe(1);
  });

  it('is one per process: a second watch takes over from the first', async () => {
    const dir = folder();
    writeFileSync(path.join(dir, 'x'), '');
    age(dir);
    fake.items.set(dir, 'login-1');
    const first = watchKeychain();
    await first.watch([dir]);
    watch = watchKeychain();
    first.stop();
    expect(readKeychainItem(dir)).toBe('login-1');
    expect(blocking()).toBe(1);
  });
});
