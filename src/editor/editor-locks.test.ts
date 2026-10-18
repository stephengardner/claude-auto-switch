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
import { carryIntoEditor, editorFolderPath, retryEditorCarry } from './folder-login.js';
import { refreshEditor } from './folder.js';
import type { CliContext } from '../context.js';

/**
 * The editor's folder and the locks its Claude takes, where ccx must neither
 * write past them nor wait for them on a thread that relays a terminal: the
 * carry of a terminal session's renewal into the folder, and a switch that
 * found them taken, finished at ccx's next event. The Keychain is a map here,
 * never the real one.
 */

const keychain = vi.hoisted(() => new Map<string, string>());
vi.mock('../accounts/keychain.js', () => ({
  keychainService: (dir: string) => `Claude Code-credentials-${dir}`,
  readKeychainCredential: vi.fn((dir: string) => keychain.get(dir) ?? null),
  writeKeychainCredential: vi.fn((dir: string, text: string) => {
    keychain.set(dir, text);
  }),
  deleteKeychainCredential: vi.fn((dir: string) => {
    keychain.delete(dir);
  }),
}));

const HOURS = 3_600_000;
const emailOf = (name: string): string => `${name.toLowerCase()}@example.com`;
const login = (name: string, gen: number): string =>
  JSON.stringify({
    account: `${name}${gen}`,
    claudeAiOauth: { accessToken: `a-${name}-${gen}`, refreshToken: `r-${name}-${gen}`, expiresAt: Date.now() + (8 + gen) * HOURS },
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

beforeEach(() => {
  keychain.clear();
});

describe("carrying a terminal session's renewal into the editor's folder", () => {
  it("never holds up the session's thread while the editor's Claude holds the lock, and carries it once that is let go", async () => {
    const s = await scene();
    const lock = path.join(s.folder, '.oauth_refresh.lock');
    mkdirSync(lock);
    const renewal = path.join(s.ccx, 'renewal.json');
    writeFileSync(renewal, login('A', 2));

    const started = Date.now();
    carryIntoEditor(s.context.ctx)(loginTextFingerprint(login('A', 1))!, renewal);
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
    const renewal = path.join(s.ccx, 'renewal.json');
    writeFileSync(renewal, login('A', 2));

    const started = Date.now();
    carryIntoEditor(s.context.ctx)(loginTextFingerprint(login('A', 1))!, renewal);
    expect(Date.now() - started).toBeLessThan(500);
    // The carry's own wait runs out meanwhile.
    await settle(3_000);
    expect(folderToken(s)).toBe('a-A-1');

    rmSync(lock, { recursive: true });
    rmSync(renewal);
    await retryEditorCarry(s.context.ctx);
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
