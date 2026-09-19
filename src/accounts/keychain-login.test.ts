import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchTokenOwner, verifyAccountIdentities } from './identity-check.js';
import {
  credentialFingerprint,
  credentialPath,
  installCredential,
  rollbackCredential,
} from './credential-vault.js';
import { hasLogin } from './account-login.js';
import { settleNewLogin } from '../login/settle-login.js';
import { loginAccount } from '../login/login.js';
import { addAccount, getAccount } from './registry.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';
import { refreshCredentialIfExpired } from '../usage/oauth-refresh.js';
import { readOauthToken } from '../usage/limit-probe.js';
import {
  readKeychainCredential,
  writeKeychainCredential,
  deleteKeychainCredential,
} from './keychain.js';
import {
  hasCredential,
  readCredential,
  writeCredential,
  removeCredential,
} from './credential-storage.js';
import { renameAccount } from './rename.js';
import { removeSessionDir, sweepDeadSessionDirs } from '../session/session-dir.js';
import { removeCommand } from '../commands/remove.js';
import { getActive, setActive } from '../state/active.js';
import { propagateRenewal } from './shared-login.js';

const keychain = vi.hoisted(() => new Map<string, string>());
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, rmSync: vi.fn(fs.rmSync) };
});
vi.mock('./keychain.js', () => ({
  readKeychainCredential: vi.fn((dir: string) => keychain.get(dir) ?? null),
  writeKeychainCredential: vi.fn((dir: string, text: string) => {
    keychain.set(dir, text);
  }),
  deleteKeychainCredential: vi.fn((dir: string) => {
    keychain.delete(dir);
  }),
}));

const credential = (token: string, expiresAt = Date.now() + 3600000): string =>
  JSON.stringify({
    claudeAiOauth: { accessToken: token, refreshToken: `refresh-${token}`, expiresAt },
  });

let home: string;
let dir: string;
let context: CliContext;
let lines: string[];
beforeEach(() => {
  vi.clearAllMocks();
  keychain.clear();
  home = mkdtempSync(path.join(tmpdir(), 'ccx-keychain-'));
  dir = path.join(home, 'profile');
  lines = [];
  const ctx = { env: { HOME: home, USERPROFILE: home, CLAUDE_AUTO_SWITCH_HOME: home } };
  context = {
    ctx,
    config: loadConfig(ctx),
    out: (line) => lines.push(line),
    json: false,
    quiet: false,
  };
  addAccount({ name: 'work', dir }, ctx);
  keychain.set(dir, credential('work-token'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const api = vi.fn(async (_url: unknown, init?: RequestInit) => {
  const token = new Headers(init?.headers).get('authorization');
  return token === 'Bearer work-token'
    ? new Response(JSON.stringify({ account: { email_address: 'work@example.com' } }))
    : new Response('{}', { status: 401 });
});

describe('Keychain-only profiles', () => {
  it('confirms the token owner and records the account after login without exporting credentials', async () => {
    expect(existsSync(credentialPath(dir))).toBe(false);
    const result = await settleNewLogin(
      context,
      { name: 'work', dir },
      {
        lookupOwner: (profile) => fetchTokenOwner(profile, api),
      },
    );
    expect(result).toEqual({ ok: true, owner: 'work@example.com' });
    expect(getAccount('work', context.ctx)?.email).toBe('work@example.com');
    expect(lines.join('\n')).not.toContain('offline');
    expect(existsSync(credentialPath(dir))).toBe(false);
    expect(await verifyAccountIdentities([{ name: 'work', dir }], api)).toMatchObject([
      { kind: 'ok', actual: 'work@example.com' },
    ]);
  });

  it('recognizes a usable login and notices a new login stored only in Keychain', async () => {
    expect(hasLogin(dir)).toBe(true);
    const before = credentialFingerprint(dir);
    expect(before).not.toBeNull();
    const result = await loginAccount(
      { name: 'work', dir },
      {
        claude: { bin: 'fake-claude', prefixArgs: [] },
        startAuthLogin: () => ({
          urlHint: async () => undefined,
          done: async () => {
            keychain.set(dir, credential('new-token'));
            return 0;
          },
        }),
        browser: { authorize: async () => 'authorized' },
        debugPort: 9222,
      },
    );
    expect(result.ok).toBe(true);
    expect(credentialFingerprint(dir)).not.toBe(before);
  });

  it('takes the initial fingerprint before starting a fast login process', async () => {
    const result = await loginAccount(
      { name: 'work', dir },
      {
        claude: { bin: 'fake-claude', prefixArgs: [] },
        startAuthLogin: () => {
          keychain.set(dir, credential('new-token'));
          return { urlHint: async () => undefined, done: async () => 1 };
        },
        browser: { authorize: async () => 'failed' },
        debugPort: 9222,
      },
    );
    expect(result).toMatchObject({ ok: true, detail: 'logged in (completed manually)' });
  });

  it('refuses a shared refresh token offline and removes only the refused Keychain entry', async () => {
    const other = path.join(home, 'other');
    keychain.set(other, credential('work-token'));
    addAccount({ name: 'other', dir: other }, context.ctx);
    const lookupOwner = vi.fn(async () => null);
    expect(await settleNewLogin(context, { name: 'work', dir }, { lookupOwner })).toMatchObject({
      ok: false,
      twin: 'other',
    });
    expect(lookupOwner).not.toHaveBeenCalled();
    expect(keychain.has(dir)).toBe(false);
    expect(keychain.has(other)).toBe(true);
  });

  it('copies into a session, updates an existing Keychain login, and rolls it back', () => {
    const session = path.join(home, 'session');
    expect(installCredential(session, credentialPath(dir))).toBe(true);
    expect(readOauthToken(credentialPath(session))).toBe('work-token');
    keychain.set(session, credential('session-renewed'));
    expect(installCredential(dir, credentialPath(session))).toBe(true);
    expect(readOauthToken(credentialPath(dir))).toBe('session-renewed');
    expect(existsSync(credentialPath(dir))).toBe(false);
    expect(rollbackCredential(dir)).toBe(true);
    expect(readOauthToken(credentialPath(dir))).toBe('work-token');
  });

  it('uses Keychain ahead of a stale fallback file and persists renewals to Keychain', async () => {
    writeFileSync(credentialPath(home), credential('stale-file'));
    keychain.set(home, credential('expiring-token', 1));
    const fetchImpl = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            access_token: 'renewed',
            refresh_token: 'renewed-refresh',
            expires_in: 3600,
          }),
        ),
    );
    expect(await refreshCredentialIfExpired(home, { fetchImpl })).toMatchObject({
      status: 'refreshed',
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).refresh_token).toBe(
      'refresh-expiring-token',
    );
    expect(readOauthToken(credentialPath(home))).toBe('renewed');
  });

  it('does not read or overwrite a stale file when Keychain is inaccessible', () => {
    const file = credentialPath(home);
    const stale = credential('stale');
    writeFileSync(file, stale);
    vi.mocked(readKeychainCredential).mockImplementationOnce(() => {
      throw new Error('locked');
    });
    expect(() => readCredential(file)).toThrow('locked');
    vi.mocked(readKeychainCredential).mockImplementationOnce(() => {
      throw new Error('locked');
    });
    expect(() => writeCredential(file, credential('replacement'))).toThrow('locked');
    expect(readFileSync(file, 'utf8')).toBe(stale);
  });

  it('distinguishes an absent credential from a failed Keychain or file read', () => {
    expect(hasCredential(credentialPath(dir))).toBe(true);
    expect(hasCredential(credentialPath(home))).toBe(false);
    vi.mocked(readKeychainCredential).mockImplementationOnce(() => {
      throw new Error('Keychain is locked');
    });
    expect(() => hasCredential(credentialPath(dir))).toThrow('Keychain is locked');
    mkdirSync(credentialPath(home));
    expect(() => hasCredential(credentialPath(home))).toThrow();
  });

  it('surfaces failed Keychain writes without falling back to a file', () => {
    vi.mocked(writeKeychainCredential).mockImplementationOnce(() => {
      throw new Error('locked');
    });
    expect(() => writeCredential(credentialPath(dir), credential('replacement'))).toThrow('locked');
    expect(existsSync(credentialPath(dir))).toBe(false);
    expect(readOauthToken(credentialPath(dir))).toBe('work-token');
  });

  it('removes both credential stores, and does not claim success when Keychain deletion fails', () => {
    mkdirSync(dir);
    writeFileSync(credentialPath(dir), credential('stale'));
    vi.mocked(deleteKeychainCredential).mockImplementationOnce(() => {
      throw new Error('locked');
    });
    expect(() => removeCredential(credentialPath(dir))).toThrow('locked');
    expect(keychain.has(dir)).toBe(true);
    expect(existsSync(credentialPath(dir))).toBe(false);
    removeCredential(credentialPath(dir));
    expect(keychain.has(dir)).toBe(false);
    expect(existsSync(credentialPath(dir))).toBe(false);
  });

  it('attempts both credential deletions and reports both failures', () => {
    mkdirSync(credentialPath(home));
    keychain.set(home, credential('leftover'));
    vi.mocked(deleteKeychainCredential).mockImplementationOnce(() => {
      throw new Error('Keychain is locked');
    });
    let failure: unknown;
    try {
      removeCredential(credentialPath(home));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect((failure as AggregateError).errors[0].message).toBe('Keychain is locked');
  });

  it('keeps a Keychain-backed profile path stable when renaming its account', () => {
    const oldDir = path.join(home, 'profiles', 'old');
    mkdirSync(oldDir, { recursive: true });
    keychain.set(oldDir, credential('old'));
    addAccount({ name: 'old', dir: oldDir }, context.ctx);
    expect(renameAccount('old', 'new', {}, context.ctx)).toMatchObject({ folderMoved: false });
    expect(getAccount('new', context.ctx)?.dir).toBe(oldDir);
    expect(readOauthToken(credentialPath(oldDir))).toBe('old');
  });

  it('renames the account without moving its folder when Keychain cannot be checked', () => {
    const oldDir = path.join(home, 'profiles', 'old');
    mkdirSync(oldDir, { recursive: true });
    keychain.set(oldDir, credential('old'));
    addAccount({ name: 'old', dir: oldDir }, context.ctx);
    vi.mocked(readKeychainCredential).mockImplementationOnce(() => {
      throw new Error('Keychain is locked');
    });
    const result = renameAccount('old', 'new', {}, context.ctx);
    expect(result.folderMoved).toBe(false);
    expect(result.folderNote).toContain('Keychain is locked');
    expect(getAccount('old', context.ctx)).toBeUndefined();
    expect(getAccount('new', context.ctx)?.dir).toBe(oldDir);
    expect(existsSync(oldDir)).toBe(true);
    expect(existsSync(path.join(home, 'profiles', 'new'))).toBe(false);
    expect(readOauthToken(credentialPath(oldDir))).toBe('old');
  });

  it('cleans up session and purged profile Keychain entries', () => {
    mkdirSync(dir);
    expect(removeSessionDir(dir)).toBe(true);
    expect(keychain.has(dir)).toBe(false);
    const purgeDir = path.join(home, 'profiles', 'purge');
    mkdirSync(purgeDir, { recursive: true });
    keychain.set(purgeDir, credential('purge'));
    addAccount({ name: 'purge', dir: purgeDir }, context.ctx);
    expect(removeCommand(context, 'purge', { purge: true })).toBe(0);
    expect(keychain.has(purgeDir)).toBe(false);
    expect(existsSync(purgeDir)).toBe(false);
  });

  it('clears an absent session directory Keychain entry and returns false', () => {
    expect(existsSync(dir)).toBe(false);
    expect(removeSessionDir(dir)).toBe(false);
    expect(keychain.has(dir)).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it('preserves an absent session path after credential cleanup fails so the sweep retries', () => {
    const session = path.join(home, 'sessions', '123');
    keychain.set(session, credential('session'));
    vi.mocked(deleteKeychainCredential).mockImplementationOnce(() => {
      throw new Error('locked');
    });
    expect(removeSessionDir(session)).toBe(false);
    expect(existsSync(session)).toBe(true);
    expect(keychain.has(session)).toBe(true);
    expect(sweepDeadSessionDirs(context.ctx, { isAlive: () => false })).toEqual(['123']);
    expect(existsSync(session)).toBe(false);
    expect(keychain.has(session)).toBe(false);
  });

  it('retries credential cleanup for an outside-tree account before deregistering it', () => {
    mkdirSync(dir);
    const keptFile = path.join(dir, 'keep.txt');
    writeFileSync(keptFile, 'keep');
    setActive('work', context.ctx);
    vi.mocked(deleteKeychainCredential).mockImplementationOnce(() => {
      throw new Error('locked');
    });
    expect(removeCommand(context, 'work', { purge: true })).toBe(1);
    expect(getAccount('work', context.ctx)?.dir).toBe(dir);
    expect(getActive(context.ctx)).toBe('work');
    expect(keychain.has(dir)).toBe(true);
    expect(removeCommand(context, 'work', { purge: true })).toBe(0);
    expect(keychain.has(dir)).toBe(false);
    expect(getAccount('work', context.ctx)).toBeUndefined();
    expect(getActive(context.ctx)).toBeNull();
    expect(readFileSync(keptFile, 'utf8')).toBe('keep');
  });

  it.each(['keychain', 'file'])('restores a %s session login after partial deletion and retries the sweep', (store) => {
    const session = path.join(home, 'sessions', '123');
    mkdirSync(session, { recursive: true });
    const login = credential('session');
    if (store === 'keychain') keychain.set(session, login);
    else writeFileSync(credentialPath(session), login);
    const realRm = vi.mocked(rmSync).getMockImplementation()!;
    vi.mocked(rmSync).mockImplementation((target, options) => {
      realRm(target, options);
      if (target === session) throw new Error('partial deletion');
    });
    try {
      expect(sweepDeadSessionDirs(context.ctx, { isAlive: () => false })).toEqual([]);
      expect(readCredential(credentialPath(session))).toBe(login);
    } finally {
      vi.mocked(rmSync).mockImplementation(realRm);
    }
    expect(sweepDeadSessionDirs(context.ctx, { isAlive: () => false })).toEqual(['123']);
    expect(existsSync(session)).toBe(false);
    expect(keychain.has(session)).toBe(false);
  });

  it.each(['credential', 'directory'])('retains the registered active account after a %s purge failure', (failure) => {
    const profile = path.join(home, 'profiles', 'purge');
    mkdirSync(profile, { recursive: true });
    keychain.set(profile, credential('purge'));
    addAccount({ name: 'purge', dir: profile }, context.ctx);
    setActive('purge', context.ctx);
    const realRm = vi.mocked(rmSync).getMockImplementation()!;
    if (failure === 'credential') {
      vi.mocked(deleteKeychainCredential).mockImplementationOnce(() => { throw new Error('locked'); });
    } else {
      vi.mocked(rmSync).mockImplementation((target, options) => {
        if (target === profile) throw new Error('busy');
        realRm(target, options);
      });
    }
    try {
      expect(removeCommand(context, 'purge', { purge: true })).toBe(1);
      expect(getAccount('purge', context.ctx)?.dir).toBe(profile);
      expect(getActive(context.ctx)).toBe('purge');
      expect(lines.join('\n')).toContain('account remains registered');
    } finally {
      vi.mocked(rmSync).mockImplementation(realRm);
    }
    expect(removeCommand(context, 'purge', { purge: true })).toBe(0);
    expect(getAccount('purge', context.ctx)).toBeUndefined();
    expect(getActive(context.ctx)).toBeNull();
  });

  it('propagates a verified renewal from a Keychain snapshot to a matching sibling', () => {
    const sibling = path.join(home, 'sibling');
    mkdirSync(dir);
    mkdirSync(sibling);
    keychain.set(sibling, keychain.get(dir)!);
    const retired = credentialFingerprint(dir);
    keychain.set(dir, credential('renewed'));
    expect(
      propagateRenewal({
        renewedDir: dir,
        retired,
        renewed: credentialFingerprint(dir),
        siblings: [{ name: 'sibling', dir: sibling }],
      }),
    ).toEqual(['sibling']);
    expect(readOauthToken(credentialPath(sibling))).toBe('renewed');
  });
});
