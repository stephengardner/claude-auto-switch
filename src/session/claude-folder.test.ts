import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { KeychainIo } from '../accounts/keychain-view.js';
import { moveFolderLogin, sessionLoginStore, type FolderLoginStore } from './claude-folder.js';

/** A login store that only records what the move asked of it. */
function recordingStore(calls: string[]): FolderLoginStore {
  return {
    *install() {
      calls.push('install');
      return true;
    },
    *scrub() {
      calls.push('scrub');
    },
    *rollback() {
      calls.push('rollback');
    },
    *nudge() {
      return true;
    },
  };
}

/** A home of its own, and a ctx that finds the user's files in it. */
function home(): { home: string; ctx: { env: NodeJS.ProcessEnv } } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-claude-folder-'));
  return { home: dir, ctx: { env: { HOME: dir, USERPROFILE: dir } } };
}

describe("a move of a folder's login", () => {
  it('is rolled back when who the folder says it is cannot be written', () => {
    const { home: root, ctx } = home();
    const dir = path.join(root, 'folder');
    const next = path.join(root, 'B');
    mkdirSync(next, { recursive: true });
    writeFileSync(
      path.join(next, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'b@example.com' }, userID: 'b' }),
    );
    // A folder in the way of the file, so the write of the identity fails while the login goes in.
    mkdirSync(path.join(dir, '.claude.json'), { recursive: true });
    writeFileSync(path.join(dir, '.ccx-base.claude.json'), '{}');
    const calls: string[] = [];

    expect(() =>
      moveFolderLogin(dir, next, ctx, recordingStore(calls), {
        *installed() {
          calls.push('installed');
        },
      }),
    ).toThrow();

    expect(calls).toEqual(['install', 'rollback']);
  });

  const someone = (email: string, id: string) => ({
    hasCompletedOnboarding: true,
    theme: 'dark',
    oauthAccount: { emailAddress: email },
    userID: id,
  });
  for (const [whose, inFolder, inUsers] of [
    ["the last account's", someone('a@example.com', 'a'), null],
    ["the user's own", null, someone('me@example.com', 'me')],
  ] as const) {
    it(`gives a folder none of ${whose} identity when the next account has none of its own`, () => {
      const { home: root, ctx } = home();
      const dir = path.join(root, 'folder');
      mkdirSync(dir, { recursive: true });
      if (inFolder) writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(inFolder));
      if (inUsers) writeFileSync(path.join(root, '.claude.json'), JSON.stringify(inUsers));
      const next = path.join(root, 'B');
      mkdirSync(next, { recursive: true });

      moveFolderLogin(dir, next, ctx, recordingStore([]));

      const state = JSON.parse(readFileSync(path.join(dir, '.claude.json'), 'utf8')) as Record<string, unknown>;
      expect(state).not.toHaveProperty('oauthAccount');
      expect(state).not.toHaveProperty('userID');
      expect(state.theme).toBe('dark');
    });
  }
});

const login = (token: string, mcpOAuth?: unknown): string =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: `at-${token}`,
      refreshToken: `rt-${token}`,
      expiresAt: 1_800_000_000_000,
    },
    ...(mcpOAuth === undefined ? {} : { mcpOAuth }),
  });
/** Sign-ins to MCP servers, which Claude keeps in the same text as the account's login. */
const mcp = (n: number) => ({
  'notion|1': { accessToken: `mcp-access-fake-${n}`, refreshToken: `mcp-refresh-fake-${n}` },
});
const signedOut = (mcpOAuth: unknown): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 }, mcpOAuth });

/** The Keychain as a map the folder's login store reaches, never the real one. */
function keychain(): { io: KeychainIo; items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    io: {
      read: (dir) => items.get(dir) ?? null,
      write: (dir, text) => {
        items.set(dir, text);
      },
      remove: (dir) => {
        items.delete(dir);
      },
    },
  };
}

/** A session folder, and the next account's folder, whose login is `next`. */
function scene(next: string) {
  const { home: root, ctx } = home();
  const dir = path.join(root, 'folder');
  mkdirSync(dir, { recursive: true });
  const account = path.join(root, 'B');
  mkdirSync(account, { recursive: true });
  writeFileSync(path.join(account, '.credentials.json'), next);
  writeFileSync(
    path.join(account, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'b@example.com' }, userID: 'b' }),
  );
  return { dir, account, ctx, file: path.join(dir, '.credentials.json') };
}

/** Make the write of who the folder says it is signed in as fail, once the login is in. */
function breakIdentityWrite(dir: string): void {
  mkdirSync(path.join(dir, '.claude.json'), { recursive: true });
  writeFileSync(path.join(dir, '.ccx-base.claude.json'), '{}');
}

describe("a session folder's login, as a move changes it", () => {
  it('keeps the MCP logins the folder holds, and none of those the next account was saved with', () => {
    const s = scene(login('b', mcp(2)));
    writeFileSync(s.file, login('a', mcp(1)));

    moveFolderLogin(s.dir, s.account, s.ctx, sessionLoginStore(s.dir, keychain().io));

    expect(readFileSync(s.file, 'utf8')).toBe(login('b', mcp(1)));
  });

  it('keeps them in a folder whose Claude signed out, though it holds no login', () => {
    const s = scene(login('b', mcp(2)));
    writeFileSync(s.file, signedOut(mcp(1)));

    moveFolderLogin(s.dir, s.account, s.ctx, sessionLoginStore(s.dir, keychain().io));

    expect(readFileSync(s.file, 'utf8')).toBe(login('b', mcp(1)));
  });

  it('keeps them in the Keychain item Claude moved the login to', () => {
    const s = scene(login('b', mcp(2)));
    const { io, items } = keychain();
    items.set(s.dir, login('a', mcp(1)));

    moveFolderLogin(s.dir, s.account, s.ctx, sessionLoginStore(s.dir, io));

    expect(items.get(s.dir)).toBe(login('b', mcp(1)));
  });

  it('starts a folder that has no login from the next account whole, MCP logins parked in it included', () => {
    const s = scene(login('b', mcp(2)));

    moveFolderLogin(s.dir, s.account, s.ctx, sessionLoginStore(s.dir, keychain().io));

    expect(readFileSync(s.file, 'utf8')).toBe(login('b', mcp(2)));
  });

  it('writes the next account exactly as saved when neither holds any', () => {
    const saved = `${JSON.stringify(JSON.parse(login('b')), null, 2)}\n`;
    const s = scene(saved);
    writeFileSync(s.file, login('a'));

    moveFolderLogin(s.dir, s.account, s.ctx, sessionLoginStore(s.dir, keychain().io));

    expect(readFileSync(s.file, 'utf8')).toBe(saved);
  });
});

describe('a move of a session folder that is rolled back', () => {
  it('puts back exactly what the folder held, though it held no usable Claude login', () => {
    const s = scene(login('b', mcp(2)));
    const before = signedOut(mcp(1));
    writeFileSync(s.file, before);
    breakIdentityWrite(s.dir);

    expect(() =>
      moveFolderLogin(s.dir, s.account, s.ctx, sessionLoginStore(s.dir, keychain().io)),
    ).toThrow();

    expect(readFileSync(s.file, 'utf8')).toBe(before);
  });

  it('puts back what the folder held, not an older copy kept beside it', () => {
    const s = scene(login('b', mcp(2)));
    const before = signedOut(mcp(1));
    writeFileSync(s.file, before);
    writeFileSync(path.join(s.dir, '.credentials.prev.json'), login('older', mcp(0)));
    breakIdentityWrite(s.dir);

    expect(() =>
      moveFolderLogin(s.dir, s.account, s.ctx, sessionLoginStore(s.dir, keychain().io)),
    ).toThrow();

    expect(readFileSync(s.file, 'utf8')).toBe(before);
  });

  it('puts back the item it replaced in the Keychain', () => {
    const s = scene(login('b', mcp(2)));
    const { io, items } = keychain();
    items.set(s.dir, login('a', mcp(1)));
    breakIdentityWrite(s.dir);

    expect(() => moveFolderLogin(s.dir, s.account, s.ctx, sessionLoginStore(s.dir, io))).toThrow();

    expect(items.get(s.dir)).toBe(login('a', mcp(1)));
  });

  it('puts back the item when the write that replaced it is reported failed after it went in', () => {
    const s = scene(login('b', mcp(2)));
    const { io, items } = keychain();
    items.set(s.dir, login('a', mcp(1)));
    const refusing: KeychainIo = {
      ...io,
      write: (dir, text) => {
        items.set(dir, text);
        if (text.includes('at-b'))
          throw new Error('Could not save the profile login in macOS Keychain');
      },
    };

    expect(() =>
      moveFolderLogin(s.dir, s.account, s.ctx, sessionLoginStore(s.dir, refusing)),
    ).toThrow('Could not save the profile login in macOS Keychain');

    expect(items.get(s.dir)).toBe(login('a', mcp(1)));
  });

  it('leaves a folder that had no login with none', () => {
    const s = scene(login('b', mcp(2)));
    breakIdentityWrite(s.dir);

    expect(() =>
      moveFolderLogin(s.dir, s.account, s.ctx, sessionLoginStore(s.dir, keychain().io)),
    ).toThrow();

    expect(existsSync(s.file)).toBe(false);
  });

  it('puts back the login that was scrubbed, when the next account has none to give', () => {
    const s = scene(JSON.stringify({ claudeAiOauth: { accessToken: '' } }));
    const before = login('a', mcp(1));
    writeFileSync(s.file, before);
    breakIdentityWrite(s.dir);

    expect(() =>
      moveFolderLogin(s.dir, s.account, s.ctx, sessionLoginStore(s.dir, keychain().io)),
    ).toThrow();

    expect(readFileSync(s.file, 'utf8')).toBe(before);
  });

  it("keeps an MCP sign-in the folder's Claude refreshed meanwhile, rather than bringing back the one it replaced", () => {
    const s = scene(login('b', mcp(2)));
    writeFileSync(s.file, login('a', mcp(1)));

    expect(() =>
      moveFolderLogin(s.dir, s.account, s.ctx, sessionLoginStore(s.dir, keychain().io), {
        *installed() {
          writeFileSync(s.file, login('b', mcp(3)));
          throw new Error('the move fails after Claude saved');
        },
      }),
    ).toThrow('the move fails after Claude saved');

    expect(readFileSync(s.file, 'utf8')).toBe(login('a', mcp(3)));
  });
});
