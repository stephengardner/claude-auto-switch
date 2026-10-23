import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addCommand } from '../commands/add.js';
import { useCommand } from '../commands/use.js';
import { editorCommand } from '../commands/editor.js';
import { setActive } from '../state/active.js';
import { loadConfig } from '../config/config.js';
import { loginTextFingerprint } from '../accounts/credential-vault.js';
import { readKeychainCredential, writeKeychainCredential } from '../accounts/keychain.js';
import { refreshCredentialIfExpired } from '../usage/oauth-refresh.js';
import { refreshUsage } from '../usage/usage-store.js';
import { carryIntoEditor, editorFolderPath, queueEditorCarry, retryEditorCarries } from './folder-login.js';
import { moveEditorToActive, refreshEditor } from './folder.js';
import type { CliContext } from '../context.js';

/**
 * The editor's folder and the locks its Claude takes, where ccx must neither
 * write past them nor wait for them on a thread that relays a terminal: the
 * carry of a terminal session's renewal into the folder, and a switch that
 * found them taken, finished at ccx's next event. The Keychain is a map here,
 * never the real one.
 */

const keychain = vi.hoisted(() => new Map<string, string>());
vi.mock('../accounts/keychain.js', () => {
  const read = vi.fn((dir: string) => keychain.get(dir) ?? null);
  const write = vi.fn((dir: string, text: string) => {
    keychain.set(dir, text);
  });
  const remove = vi.fn((dir: string) => {
    keychain.delete(dir);
  });
  return {
    keychainService: (dir: string) => `Claude Code-credentials-${dir}`,
    readKeychainCredential: read,
    writeKeychainCredential: write,
    deleteKeychainCredential: remove,
    // Off the thread, the same Keychain: what a test stages on the blocking form holds here too.
    readKeychainCredentialAsync: async (dir: string) => read(dir),
    writeKeychainCredentialAsync: async (dir: string, text: string) => write(dir, text),
    deleteKeychainCredentialAsync: async (dir: string) => remove(dir),
  };
});

const HOURS = 3_600_000;
const emailOf = (name: string): string => `${name.toLowerCase()}@example.com`;
const login = (name: string, gen: number, expiresAt = Date.now() + (8 + gen) * HOURS): string =>
  JSON.stringify({
    account: `${name}${gen}`,
    claudeAiOauth: { accessToken: `a-${name}-${gen}`, refreshToken: `r-${name}-${gen}`, expiresAt },
  });
const tokenOf = (text: string | null): string | null => {
  try {
    return (JSON.parse(text ?? '') as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
};
const read = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(done: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!done() && Date.now() < until) await settle(25);
}

interface Scene {
  ccx: string;
  folder: string;
  context: CliContext;
}

/** Two accounts, A active, and the editor set up on its folder on A. */
async function scene(): Promise<Scene> {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-editor-locks-'));
  const ccx = path.join(home, 'ccx');
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: ccx, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData') } };
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
    lookupOwner: (dir) => {
      const token = tokenOf(read(path.join(dir, '.credentials.json'))) ?? '';
      const match = /^a-([A-Za-z]+)-/.exec(token);
      return Promise.resolve(match ? emailOf(match[1]!) : null);
    },
  };
  for (const name of ['A', 'B']) {
    const dir = path.join(ccx, 'profiles', name);
    await addCommand(context, name, { dir, login: false, email: emailOf(name) });
    writeFileSync(path.join(dir, '.credentials.json'), login(name, 1));
    writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: emailOf(name), accountUuid: `uuid-${name}` }, userID: `user-${name}` }),
    );
  }
  setActive('A', ctx);
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));
  expect(await editorCommand(context, 'on')).toBe(0);
  const folder = editorFolderPath(ctx);
  expect(tokenOf(read(path.join(folder, '.credentials.json')))).toBe('a-A-1');
  return { ccx, folder, context };
}

const folderToken = (s: Scene): string | null => tokenOf(read(path.join(s.folder, '.credentials.json')));
const profileDir = (s: Scene, name: string): string => path.join(s.ccx, 'profiles', name);

/** A renewal of `name`'s login, gen 1 to 2, saved home as a session's mirror saves it, and its verified copy. */
function renewedHome(s: Scene, name: string): string {
  writeFileSync(path.join(profileDir(s, name), '.credentials.json'), login(name, 2));
  const copy = path.join(s.ccx, `renewal-${name}.json`);
  writeFileSync(copy, login(name, 2));
  return copy;
}

/** Run `step` while the Keychain item named after the editor's folder cannot be read. */
async function whileUnreadable<T>(s: Scene, step: () => Promise<T>): Promise<T> {
  vi.mocked(readKeychainCredential).mockImplementation((dir: string) => {
    if (dir === s.folder) throw new Error('Could not read the profile login from macOS Keychain');
    return keychain.get(dir) ?? null;
  });
  try {
    return await step();
  } finally {
    vi.mocked(readKeychainCredential).mockImplementation((dir: string) => keychain.get(dir) ?? null);
  }
}

const tokenResponse = (name: string, gen: number): Response =>
  new Response(
    JSON.stringify({ access_token: `a-${name}-${gen}`, refresh_token: `r-${name}-${gen}`, expires_in: 8 * 3600 }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
const itemToken = (s: Scene): string | null => tokenOf(keychain.get(s.folder) ?? null);

/** The editor on A, its login in the Keychain item named after its folder, and A's login due for renewal. */
async function dueInTheKeychain(): Promise<Scene> {
  const s = await scene();
  keychain.set(s.folder, login('A', 1));
  writeFileSync(path.join(profileDir(s, 'A'), '.credentials.json'), login('A', 1, Date.now() + 60_000));
  return s;
}

/** Renew A as the usage refresh does, with the write into the editor's folder failing once. */
async function renewWithAFailedWrite(s: Scene, soonMs?: number): Promise<void> {
  let failed = false;
  vi.mocked(writeKeychainCredential).mockImplementation((dir: string, text: string) => {
    if (dir === s.folder && !failed) {
      failed = true;
      throw new Error('Could not save the login to macOS Keychain');
    }
    keychain.set(dir, text);
  });
  const outcome = await refreshCredentialIfExpired(profileDir(s, 'A'), {
    ctx: s.context.ctx,
    fetchImpl: () => Promise.resolve(tokenResponse('A', 2)),
    ...(soonMs !== undefined ? { editorCarrySoonMs: soonMs } : {}),
  });
  expect(outcome.status).toBe('refreshed');
  expect(itemToken(s)).toBe('a-A-1');
}

beforeEach(() => {
  keychain.clear();
  vi.mocked(readKeychainCredential).mockImplementation((dir: string) => keychain.get(dir) ?? null);
  vi.mocked(writeKeychainCredential).mockImplementation((dir: string, text: string) => {
    keychain.set(dir, text);
  });
});

describe("a renewal the editor's folder could not be written with", () => {
  it("reaches the folder at the usage refresh's next look, with no terminal session running", async () => {
    const s = await dueInTheKeychain();
    await renewWithAFailedWrite(s, 0);

    await refreshUsage([], s.context.ctx);

    expect(itemToken(s)).toBe('a-A-2');
  });

  it('is tried again at once by the process that renewed, before it may end', async () => {
    const s = await dueInTheKeychain();
    await renewWithAFailedWrite(s);

    await waitFor(() => itemToken(s) === 'a-A-2', 4_000);
    expect(itemToken(s)).toBe('a-A-2');
  });

  it("stays queued when what the folder holds cannot be read as it is made, and is made at the next look", async () => {
    const s = await scene();
    keychain.set(s.folder, login('A', 1));
    renewedHome(s, 'A');
    queueEditorCarry(s.context.ctx, loginTextFingerprint(login('A', 1))!, profileDir(s, 'A'));
    // The folder's Keychain item reads once, then not, as a Keychain locked between two reads.
    let reads = 0;
    vi.mocked(readKeychainCredential).mockImplementation((dir: string) => {
      if (dir === s.folder && ++reads === 2) throw new Error('Could not read the profile login from macOS Keychain');
      return keychain.get(dir) ?? null;
    });
    try {
      await retryEditorCarries(s.context.ctx);
    } finally {
      vi.mocked(readKeychainCredential).mockImplementation((dir: string) => keychain.get(dir) ?? null);
    }
    expect(itemToken(s)).toBe('a-A-1');

    await retryEditorCarries(s.context.ctx);

    expect(itemToken(s)).toBe('a-A-2');
  });
});

describe("carrying a terminal session's renewal into the editor's folder", () => {
  it("keeps each carry until it is made, a later one for another login included", { timeout: 20_000 }, async () => {
    const s = await scene();
    const lock = path.join(s.folder, '.oauth_refresh.lock');
    mkdirSync(lock);
    carryIntoEditor(s.context.ctx, profileDir(s, 'A'))(loginTextFingerprint(login('A', 1))!, renewedHome(s, 'A'));
    // Its wait for the lock runs out.
    await settle(3_000);
    // Then a renewal of B's login, while what the editor's folder holds cannot be read.
    const renewalB = renewedHome(s, 'B');
    await whileUnreadable(s, async () => {
      carryIntoEditor(s.context.ctx, profileDir(s, 'B'))(loginTextFingerprint(login('B', 1))!, renewalB);
      await settle(100);
    });
    expect(folderToken(s)).toBe('a-A-1');

    rmSync(lock, { recursive: true });
    await refreshUsage([], s.context.ctx);

    expect(folderToken(s)).toBe('a-A-2');
  });

  it("never holds up the session's thread while the editor's Claude holds the lock, and carries it once that is let go", async () => {
    const s = await scene();
    const lock = path.join(s.folder, '.oauth_refresh.lock');
    mkdirSync(lock);
    const renewal = renewedHome(s, 'A');

    const started = Date.now();
    carryIntoEditor(s.context.ctx, profileDir(s, 'A'))(loginTextFingerprint(login('A', 1))!, renewal);
    expect(Date.now() - started).toBeLessThan(500);
    expect(folderToken(s)).toBe('a-A-1');

    setTimeout(() => rmSync(lock, { recursive: true }), 300);
    await waitFor(() => folderToken(s) === 'a-A-2', 4_000);
    expect(folderToken(s)).toBe('a-A-2');
  });

  it("carries it at the session's next look when the editor's Claude held the lock past the wait", { timeout: 20_000 }, async () => {
    const s = await scene();
    const lock = path.join(s.folder, '.oauth_refresh.lock');
    mkdirSync(lock);
    const renewal = renewedHome(s, 'A');

    const started = Date.now();
    carryIntoEditor(s.context.ctx, profileDir(s, 'A'))(loginTextFingerprint(login('A', 1))!, renewal);
    expect(Date.now() - started).toBeLessThan(500);
    // The carry's own wait runs out meanwhile.
    await settle(3_000);
    expect(folderToken(s)).toBe('a-A-1');

    rmSync(lock, { recursive: true });
    rmSync(renewal);
    await retryEditorCarries(s.context.ctx);
    expect(folderToken(s)).toBe('a-A-2');
  });
});

describe("a switch the editor's Claude held off", () => {
  it("is made at ccx's next event when the editor's Claude held its lock for the whole of the switch", { timeout: 20_000 }, async () => {
    const s = await scene();
    s.context.editorMoveRetryMs = 300;
    const lock = path.join(s.folder, '.oauth_refresh.lock');
    mkdirSync(lock);

    expect(useCommand(s.context, 'B', {}, () => [])).toBe(0);
    await settle(3_000);
    expect(folderToken(s)).toBe('a-A-1');
    expect(existsSync(path.join(s.ccx, 'editor-move-pending.json'))).toBe(true);

    rmSync(lock, { recursive: true });
    // A checkup: an event that moves nothing by itself.
    await refreshEditor(s.context);
    expect(folderToken(s)).toBe('a-B-1');
    expect(existsSync(path.join(s.ccx, 'editor-move-pending.json'))).toBe(false);
  });
});

describe("the editor's folder brought into step for a running session", () => {
  it("never waits on the session's thread for ccx's own write-back lock", { timeout: 20_000 }, async () => {
    const s = await scene();
    // Another ccx is handing a session's settings back, and keeps the lock meanwhile.
    const lock = path.join(s.ccx, 'write-back.lock');
    mkdirSync(lock);
    try {
      const started = Date.now();
      const up = await moveEditorToActive(s.context, { session: true });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(up.state).toBe('ready');
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  });
});
