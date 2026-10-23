import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from '../../src/commands/run.js';
import { addAccount } from '../../src/accounts/registry.js';
import { setActive } from '../../src/state/active.js';
import { loadConfig } from '../../src/config/config.js';
import { sessionDirFor } from '../../src/session/session-dir.js';
import type { CliContext } from '../../src/context.js';
import { watchRelay, type RelayedLine } from './relay-watch.js';
import { FAKE_ENV, PTY_AVAILABLE, fakeClaude, freshUsage } from './typeable-claude.js';

/**
 * On macOS a running session reads its logins from the Keychain through
 * `security`, which takes tens of milliseconds a call, and up to the 2 s it is
 * allowed. Here `security` is a stand-in that takes 100 ms: the Keychain is a
 * map in this process, and each call is noted with when it ran and whether it
 * held the thread (the form that blocks) or left it free.
 */
const fake = vi.hoisted(() => ({
  items: new Map<string, string>(),
  calls: [] as Array<{ dir: string; blocking: boolean; start: number; end: number }>,
}));
vi.mock('../../src/accounts/keychain.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/accounts/keychain.js')>();
  const TAKES_MS = 100;
  const blocking = <T>(dir: string, answer: () => T): T => {
    const start = Date.now();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TAKES_MS);
    fake.calls.push({ dir, blocking: true, start, end: Date.now() });
    return answer();
  };
  const waiting = async <T>(dir: string, answer: () => T): Promise<T> => {
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, TAKES_MS));
    fake.calls.push({ dir, blocking: false, start, end: Date.now() });
    return answer();
  };
  const read = (dir: string): string | null => fake.items.get(dir) ?? null;
  const write = (dir: string, text: string): void => {
    fake.items.set(dir, text.trim());
  };
  const remove = (dir: string): void => {
    fake.items.delete(dir);
  };
  return {
    ...real,
    readKeychainCredential: (dir: string) => blocking(dir, () => read(dir)),
    writeKeychainCredential: (dir: string, text: string) => blocking(dir, () => write(dir, text)),
    deleteKeychainCredential: (dir: string) => blocking(dir, () => remove(dir)),
    readKeychainCredentialAsync: (dir: string) => waiting(dir, () => read(dir)),
    writeKeychainCredentialAsync: (dir: string, text: string) => waiting(dir, () => write(dir, text)),
    deleteKeychainCredentialAsync: (dir: string) => waiting(dir, () => remove(dir)),
  };
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const HOURS = 3_600_000;
/** Account A's login, generation `gen`, which the fake Claude reports as A. */
const login = (gen: number): string =>
  JSON.stringify({
    account: 'A',
    claudeAiOauth: { accessToken: `a-A-${gen}`, refreshToken: `r-A-${gen}`, expiresAt: Date.now() + 8 * HOURS },
  });
const tokenOf = (text: string | undefined): string | null => {
  try {
    return (JSON.parse(text ?? '') as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
};
/** Until `ok` says so or `ms` have passed; never throws, so what was reached is asserted on afterwards. */
async function until(ok: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok() && Date.now() < deadline) await sleep(25);
}

interface Scene {
  home: string;
  context: CliContext;
  profileA: string;
  exitClaude: string;
}

/**
 * A session on A, whose login lives in the Keychain only, as Claude leaves a
 * profile it signed in on macOS, with B beside it. Claude prints a stamped
 * line every 100 ms until the test ends it.
 */
function scene(): Scene {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-keychain-relay-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    verifyCap: () => Promise.resolve('allowed'),
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
  };
  context.config.resume.auto = false;
  const profileA = path.join(home, 'profiles', 'A');
  const profileB = path.join(home, 'profiles', 'B');
  mkdirSync(profileA, { recursive: true });
  mkdirSync(profileB, { recursive: true });
  addAccount({ name: 'A', dir: profileA, email: 'a@example.com' }, ctx);
  addAccount({ name: 'B', dir: profileB, email: 'b@example.com' }, ctx);
  fake.items.set(profileA, login(1));
  writeFileSync(
    path.join(profileB, '.credentials.json'),
    JSON.stringify({ account: 'B', claudeAiOauth: { accessToken: 'a-B-1', refreshToken: 'r-B-1', expiresAt: Date.now() + 8 * HOURS } }),
  );
  // Set up a while ago, as a profile usually is.
  const before = new Date(Date.now() - 60_000);
  for (const dir of [profileA, profileB]) utimesSync(dir, before, before);
  freshUsage(home, ['A', 'B']);
  setActive('A', ctx);
  // Who a login belongs to, as the API says: A's tokens are a@example.com's. Nothing else answers.
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const token = new Headers(init?.headers).get('authorization') ?? '';
    if (url.endsWith('/api/oauth/profile') && token.startsWith('Bearer a-A-')) {
      return Promise.resolve(new Response(JSON.stringify({ account: { email_address: 'a@example.com' } })));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
  const exitClaude = path.join(home, 'claude-exit');
  Object.assign(process.env, {
    FAKE_CLAUDE_RUNS_LOG: path.join(home, 'runs.jsonl'),
    FAKE_CLAUDE_IDLE_MS: '40000',
    FAKE_CLAUDE_EXIT_WHEN: exitClaude,
    FAKE_CLAUDE_CHATTER_EVERY_MS: '100',
    FAKE_CLAUDE_CHATTER_STAMP: '1',
  });
  return { home, context, profileA, exitClaude };
}

/** The `security` calls that held the thread while Claude ran, and the lines Claude wrote that waited behind one. */
function heldUp(lines: RelayedLine[]): { calls: typeof fake.calls; lines: RelayedLine[] } {
  const first = lines[0]?.writtenAt ?? 0;
  const last = lines.at(-1)?.relayedAt ?? 0;
  const blocking = fake.calls.filter((c) => c.blocking);
  return {
    calls: blocking.filter((c) => c.end > first && c.start < last),
    lines: lines.filter((l) => blocking.some((c) => c.start < l.relayedAt && c.end > l.writtenAt)),
  };
}

describe.skipIf(!PTY_AVAILABLE && !process.env.CI)('a running session reading the macOS Keychain', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const name of [...FAKE_ENV, 'FAKE_CLAUDE_CHATTER_EVERY_MS', 'FAKE_CLAUDE_CHATTER_STAMP']) delete process.env[name];
    fake.items.clear();
    fake.calls.length = 0;
  });

  it("keeps relaying Claude's lines on time while every `security` call takes 100 ms", { timeout: 60_000 }, async () => {
    const s = scene();
    const relay = watchRelay();
    let exit: number;
    try {
      const running = runCommand(s.context, []);
      await until(() => relay.lines().length > 0, 30_000);
      await sleep(5_000);
      writeFileSync(s.exitClaude, '');
      exit = await running;
    } finally {
      relay.stop();
    }
    const lines = relay.lines();
    const held = heldUp(lines);
    // While Claude ran, nothing ran `security` holding the thread that relays it...
    expect(held.calls).toEqual([]);
    // ...so no line it wrote waited behind one.
    expect(held.lines).toEqual([]);
    expect(lines.length).toBeGreaterThan(30);
    expect(exit).toBe(0);
  });

  it('reads the Keychain only when a login may have changed, and notices a renewal Claude made', { timeout: 60_000 }, async () => {
    const s = scene();
    const relay = watchRelay();
    let exit: number;
    let quiet: typeof fake.calls = [];
    let renewedAt = 0;
    let noticedAt = 0;
    try {
      const running = runCommand(s.context, []);
      await until(() => relay.lines().length > 0, 30_000);
      // Settled: what was read as Claude started has been, and nothing has changed since.
      await sleep(3_000);
      const quietFrom = Date.now();
      await sleep(3_000);
      quiet = fake.calls.filter((c) => c.start >= quietFrom);
      // Claude renews its login as 2.1.302 does: under its locks in its folder,
      // saved in the Keychain item named after the folder, with the file it had gone.
      const folder = sessionDirFor(process.pid, s.context.ctx);
      const locks = [path.join(folder, '.oauth_refresh.lock'), path.join(folder, '.storage-write.lock')];
      for (const lock of locks) mkdirSync(lock);
      fake.items.set(folder, login(2));
      rmSync(path.join(folder, '.credentials.json'), { force: true });
      for (const lock of [...locks].reverse()) rmdirSync(lock);
      renewedAt = Date.now();
      // Noticed, and saved home, as a session's mirror does.
      await until(() => tokenOf(fake.items.get(s.profileA)) === 'a-A-2', 15_000);
      if (tokenOf(fake.items.get(s.profileA)) === 'a-A-2') noticedAt = Date.now();
      writeFileSync(s.exitClaude, '');
      exit = await running;
    } finally {
      relay.stop();
    }
    console.log(`a renewal Claude made reached the profile ${noticedAt ? noticedAt - renewedAt : 'never'} ms later; ${quiet.length} Keychain reads in 3 s with nothing changing`);
    // With nothing changing, at most a read or two of a folder still settling.
    expect(quiet.length).toBeLessThanOrEqual(2);
    expect(noticedAt).toBeGreaterThan(0);
    // As soon as a session read the login every 400 ms itself: within a few looks, and a few 100 ms reads.
    expect(noticedAt - renewedAt).toBeLessThan(4_000);
    expect(heldUp(relay.lines()).calls).toEqual([]);
    expect(existsSync(s.exitClaude)).toBe(true);
    expect(exit).toBe(0);
  });
});
