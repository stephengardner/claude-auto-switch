import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loginTextFingerprint } from '../accounts/credential-vault.js';
import type { KeychainIo } from '../accounts/keychain-view.js';
import { readKeychainCredential } from '../accounts/keychain.js';
import { runBlocking } from '../util/steps.js';
import {
  readFolderStores,
  replaceFolderLoginSteps,
  writeFolderLogin,
  type FolderLogin,
} from './folder-login.js';

/** The Keychain is a map here, never the real one. */
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
    readKeychainCredentialAsync: async (dir: string) => read(dir),
    writeKeychainCredentialAsync: async (dir: string, text: string) => write(dir, text),
    deleteKeychainCredentialAsync: async (dir: string) => remove(dir),
  };
});

const mcp = (n: number) => ({
  'notion|1': { accessToken: `mcp-access-fake-${n}`, refreshToken: `mcp-refresh-fake-${n}` },
});
const claudeLogin = (n: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: `a-${n}`,
      refreshToken: `r-${n}`,
      expiresAt: 1_800_000_000_000 + n,
    },
    ...extra,
  });
const mcpOf = (text: string | null | undefined): unknown =>
  (JSON.parse(text ?? 'null') as { mcpOAuth?: unknown } | null)?.mcpOAuth;
const tokenOf = (text: string | null | undefined): unknown =>
  (JSON.parse(text ?? 'null') as { claudeAiOauth?: { accessToken?: string } } | null)?.claudeAiOauth
    ?.accessToken;

function folder(spellings: string[] = []): FolderLogin {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-folder-login-'));
  mkdirSync(dir, { recursive: true });
  return { dir, spellings: spellings.length > 0 ? spellings : [dir] };
}
const fileOf = (login: FolderLogin): string => path.join(login.dir, '.credentials.json');
/** The Keychain as a map the steps reach, never the real one. */
const directly: KeychainIo = {
  read: (dir) => keychain.get(dir) ?? null,
  write: (dir, text) => {
    keychain.set(dir, text);
  },
  remove: (dir) => {
    keychain.delete(dir);
  },
};
const readFile = (login: FolderLogin): string => readFileSync(fileOf(login), 'utf8');

beforeEach(() => {
  keychain.clear();
});

describe("writing a login where each Claude on the editor's folder reads it", () => {
  it('keeps each place its own MCP logins: the item of each spelling, and the file', () => {
    const login = folder();
    const other = `${login.dir}${path.sep}`;
    const three: FolderLogin = {
      dir: login.dir,
      spellings: [login.dir, other, `${login.dir}-third`],
    };
    keychain.set(three.spellings[0]!, claudeLogin(1, { mcpOAuth: mcp(1) }));
    keychain.set(three.spellings[1]!, claudeLogin(1, { mcpOAuth: mcp(2) }));
    // The third spelling has no item, so the Claude given it reads the file.
    writeFileSync(fileOf(three), claudeLogin(1, { mcpOAuth: mcp(3) }));

    writeFolderLogin(three, claudeLogin(2, { mcpOAuth: mcp(9) }));

    expect(keychain.get(three.spellings[0]!)).toBe(claudeLogin(2, { mcpOAuth: mcp(1) }));
    expect(keychain.get(three.spellings[1]!)).toBe(claudeLogin(2, { mcpOAuth: mcp(2) }));
    expect(readFile(three)).toBe(claudeLogin(2, { mcpOAuth: mcp(3) }));
  });

  it('gives a place that holds nothing yet the login whole, MCP logins parked in it included', () => {
    const login = folder();

    writeFolderLogin(login, claudeLogin(2, { mcpOAuth: mcp(9) }));

    expect(mcpOf(readFile(login))).toEqual(mcp(9));
  });

  it('copies none of the source into places that hold a login of their own without any', () => {
    const login = folder();
    keychain.set(login.dir, claudeLogin(1));
    writeFileSync(fileOf(login), claudeLogin(1));
    const spellings: FolderLogin = { dir: login.dir, spellings: [login.dir, `${login.dir}-other`] };

    writeFolderLogin(spellings, claudeLogin(2, { mcpOAuth: mcp(9) }));

    expect(mcpOf(keychain.get(login.dir))).toBeUndefined();
    expect(mcpOf(readFile(login))).toBeUndefined();
  });
});

describe('writing a login that neither the source nor the places hold MCP logins in', () => {
  const pretty = `${JSON.stringify(JSON.parse(claudeLogin(2)), null, 2)}\n`;

  it('writes it byte for byte, into an item and into the file alike', () => {
    const login = folder();
    const other: FolderLogin = { dir: login.dir, spellings: [login.dir, `${login.dir}-other`] };
    keychain.set(login.dir, claudeLogin(1));

    writeFolderLogin(other, pretty);

    expect(keychain.get(login.dir)).toBe(pretty);
    expect(readFile(login)).toBe(pretty);
  });

  it('writes a renewal byte for byte too', () => {
    const login = folder();
    const held = claudeLogin(1);
    writeFileSync(fileOf(login), held);

    const replaced = runBlocking(
      replaceFolderLoginSteps(login, loginTextFingerprint(held)!, pretty, directly),
    );

    expect(replaced).toBe(true);
    expect(readFile(login)).toBe(pretty);
  });
});

describe('putting a renewal in the folder that holds the login it retired', () => {
  it('merges with the login the place holds when it is written, not as it was when it was looked at', () => {
    const login = folder();
    const held = claudeLogin(1, { mcpOAuth: mcp(1) });
    // The folder's Claude refreshes a sign-in meanwhile: once the first look has been made.
    const refreshed = claudeLogin(1, { mcpOAuth: mcp(2) });
    keychain.set(login.dir, held);
    let looks = 0;
    const io: KeychainIo = {
      read: (dir) => {
        const text = keychain.get(dir) ?? null;
        looks += 1;
        if (looks === 1) keychain.set(dir, refreshed);
        return text;
      },
      write: (dir, text) => {
        keychain.set(dir, text);
      },
      remove: (dir) => {
        keychain.delete(dir);
      },
    };

    const replaced = runBlocking(
      replaceFolderLoginSteps(
        login,
        loginTextFingerprint(held)!,
        claudeLogin(2, { mcpOAuth: mcp(9) }),
        io,
      ),
    );

    expect(replaced).toBe(true);
    expect(tokenOf(keychain.get(login.dir))).toBe('a-2');
    expect(mcpOf(keychain.get(login.dir))).toEqual(mcp(2));
  });
});

describe("reading every place a Claude on the editor's folder keeps its login", () => {
  it('gives the item of each spelling in order, and not the file while every spelling has one', () => {
    const login = folder();
    const other: FolderLogin = { dir: login.dir, spellings: [login.dir, `${login.dir}-other`] };
    keychain.set(other.spellings[1]!, claudeLogin(2));
    keychain.set(other.spellings[0]!, claudeLogin(1));
    writeFileSync(fileOf(other), claudeLogin(3));

    expect(readFolderStores(other)).toEqual([claudeLogin(1), claudeLogin(2)]);
  });

  it('gives the file after the items when a spelling has none, since a Claude given that spelling reads it', () => {
    const login = folder();
    const other: FolderLogin = { dir: login.dir, spellings: [login.dir, `${login.dir}-other`] };
    keychain.set(other.spellings[0]!, claudeLogin(1));
    writeFileSync(fileOf(other), claudeLogin(3));

    expect(readFolderStores(other)).toEqual([claudeLogin(1), claudeLogin(3)]);
  });

  it('gives only the places that hold something', () => {
    const login = folder();
    expect(readFolderStores(login)).toEqual([]);
    writeFileSync(fileOf(login), claudeLogin(3));
    expect(readFolderStores(login)).toEqual([claudeLogin(3)]);
  });

  it('throws when an item cannot be read, since what it holds is unknown', () => {
    const login = folder();
    const other: FolderLogin = { dir: login.dir, spellings: [login.dir, `${login.dir}-other`] };
    keychain.set(other.spellings[0]!, claudeLogin(1));
    vi.mocked(readKeychainCredential).mockImplementationOnce(() => claudeLogin(1));
    vi.mocked(readKeychainCredential).mockImplementationOnce(() => {
      throw new Error('Could not read the profile login from macOS Keychain');
    });

    expect(() => readFolderStores(other)).toThrow('Could not read the profile login');
  });
});
