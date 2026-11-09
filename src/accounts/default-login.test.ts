import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addAccount, getAccount } from './registry.js';
import type { Account } from './registry.schema.js';
import { clearCredential, credentialPath, loginTextFingerprint } from './credential-vault.js';
import { readCredential, writeCredential, DEFAULT_LOGIN_MARKER } from './credential-storage.js';
import { DEFAULT_LOGIN } from './default-login-item.js';
import { followActiveInDefaultLogin, moveIntoDefaultLogin, setDefaultLoginMode } from './default-login.js';
import { hasKeptRenewal, keepRenewal } from './kept-renewal.js';
import { keychainBlocking } from './keychain-view.js';
import { parkMcpLoginsSteps } from './mcp-park.js';
import { refreshCredentialIfExpired } from '../usage/oauth-refresh.js';
import { probe } from '../health/prober.js';
import { moveEditorToActive } from '../editor/folder.js';
import { CREDENTIALS_LOCK_DIR } from '../claude/locks.js';
import { loadConfig } from '../config/config.js';
import { setActive } from '../state/active.js';
import { runBlocking } from '../util/steps.js';
import type { CliContext } from '../context.js';

/** The Keychain is a map here, Claude's default login one item of it; nothing reaches `security`. */
const keychain = vi.hoisted(() => ({ items: new Map<string, string>(), failRemove: null as string | null }));
vi.mock('./keychain.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./keychain.js')>();
  const read = (dir: string): string | null => keychain.items.get(dir) ?? null;
  const write = (dir: string, text: string): void => {
    keychain.items.set(dir, text.trim());
  };
  const remove = (dir: string): void => {
    if (keychain.failRemove === dir) throw new Error('Could not remove the profile login from macOS Keychain');
    keychain.items.delete(dir);
  };
  return {
    ...real,
    readKeychainCredential: read,
    writeKeychainCredential: write,
    deleteKeychainCredential: remove,
    readKeychainCredentialAsync: async (dir: string) => read(dir),
    writeKeychainCredentialAsync: async (dir: string, text: string) => write(dir, text),
    deleteKeychainCredentialAsync: async (dir: string) => remove(dir),
  };
});

const EXPIRES = 4_102_444_800_000;
const login = (token: string, extra: Record<string, unknown> = {}) => ({
  accessToken: token,
  refreshToken: `refresh-${token}`,
  expiresAt: EXPIRES,
  ...extra,
});
const stored = (token: string, extra: Record<string, unknown> = {}) => JSON.stringify({ claudeAiOauth: login(token), ...extra });
const parsed = (key: string) => JSON.parse(keychain.items.get(key) ?? '{}') as Record<string, unknown>;
const CHATS_MCP = { slack: { accessToken: 'mcp' } };

let home: string;
let ctx: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv };
const state = () =>
  JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8')) as {
    oauthAccount: { emailAddress?: string; organizationUuid?: string };
    mcpServers?: unknown;
  };
const marker = (dir: string) => path.join(dir, DEFAULT_LOGIN_MARKER);
const claudeLock = () => path.join(home, '.claude', CREDENTIALS_LOCK_DIR);
const chatModeOn = () => writeFileSync(path.join(home, 'default-login.on'), '');

function profile(name: string, org: string, text = stored(`${name}-token`)): Account {
  const dir = path.join(home, 'profiles', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: `${name}@x.com`, accountUuid: name, organizationUuid: org } }),
  );
  addAccount({ name, dir }, ctx);
  keychain.items.set(dir, text);
  return getAccount(name, ctx)!;
}

async function until(ok: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
}

beforeEach(() => {
  keychain.items.clear();
  keychain.failRemove = null;
  home = mkdtempSync(path.join(tmpdir(), 'ccx-default-login-'));
  mkdirSync(path.join(home, '.claude'));
  // Claude's default login and its folder, and ~/.claude.json: all in the test's home, never the real ones.
  process.env.CCX_DEFAULT_CLAUDE_HOME = home;
  ctx = { platform: 'darwin', env: { HOME: home, USERPROFILE: home, CLAUDE_AUTO_SWITCH_HOME: home } };
  writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'me@x.com', accountUuid: 'me' }, mcpServers: { slack: {} } }),
  );
  keychain.items.set(
    DEFAULT_LOGIN,
    JSON.stringify({ claudeAiOauth: login('original'), mcpOAuth: CHATS_MCP, organizationUuid: 'org-me' }),
  );
});
afterEach(() => {
  delete process.env.CCX_DEFAULT_CLAUDE_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('chat mode: the default login follows the active account', () => {
  it("moves the login in, keeps the chats' MCP sign-ins, and leaves exactly one holder", () => {
    const work = profile('work', 'org-work');
    expect(moveIntoDefaultLogin(work, ctx)).toEqual({ state: 'moved', account: 'work' });

    expect(parsed(DEFAULT_LOGIN)).toEqual({ claudeAiOauth: login('work-token'), mcpOAuth: CHATS_MCP, organizationUuid: 'org-work' });
    expect(keychain.items.has(work.dir)).toBe(false);
    expect(existsSync(marker(work.dir))).toBe(true);
    expect(state().oauthAccount.organizationUuid).toBe('org-work');
    expect(state().mcpServers).toEqual({ slack: {} });
    // The login Claude had before is kept for `ccx chat off`.
    expect(JSON.parse(readFileSync(path.join(home, 'default-login.original.json'), 'utf8'))).toMatchObject({
      claudeAiOauth: login('original'),
      organizationUuid: 'org-me',
    });
    // ccx still reads and renews the holder, through the default login, never seeing the chats' sign-ins.
    expect(JSON.parse(readCredential(credentialPath(work.dir)))).toEqual({ claudeAiOauth: login('work-token') });
    writeCredential(credentialPath(work.dir), stored('work-renewed'));
    expect(parsed(DEFAULT_LOGIN)).toEqual({ claudeAiOauth: login('work-renewed'), mcpOAuth: CHATS_MCP, organizationUuid: 'org-work' });
    // Every lock it took is let go.
    expect(existsSync(claudeLock())).toBe(false);
    expect(existsSync(path.join(home, '.claude.json.lock'))).toBe(false);
  });

  it('switching hands the renewed login back to its owner', () => {
    const work = profile('work', 'org-work');
    const play = profile('play', 'org-play');
    moveIntoDefaultLogin(work, ctx);
    writeCredential(credentialPath(work.dir), stored('work-renewed'));

    expect(moveIntoDefaultLogin(play, ctx)).toEqual({ state: 'moved', account: 'play' });
    expect(parsed(work.dir)).toEqual({ claudeAiOauth: login('work-renewed') });
    expect(existsSync(marker(work.dir))).toBe(false);
    expect(parsed(DEFAULT_LOGIN)).toEqual({ claudeAiOauth: login('play-token'), mcpOAuth: CHATS_MCP, organizationUuid: 'org-play' });
    expect(keychain.items.has(play.dir)).toBe(false);
    expect(state().oauthAccount.emailAddress).toBe('play@x.com');
    expect(moveIntoDefaultLogin(play, ctx)).toEqual({ state: 'already', account: 'play' });
  });

  it('chat off restores the original login', async () => {
    const work = profile('work', 'org-work');
    setActive('work', ctx);
    expect(await setDefaultLoginMode(true, ctx)).toContain('"work"');
    expect(parsed(DEFAULT_LOGIN).claudeAiOauth).toEqual(login('work-token'));

    expect(await setDefaultLoginMode(false, ctx)).toBe('chat mode off: your normal Claude login is back as it was');
    expect(parsed(DEFAULT_LOGIN)).toEqual({ claudeAiOauth: login('original'), mcpOAuth: CHATS_MCP, organizationUuid: 'org-me' });
    expect(parsed(work.dir)).toEqual({ claudeAiOauth: login('work-token') });
    expect(existsSync(marker(work.dir))).toBe(false);
    expect(state().oauthAccount.emailAddress).toBe('me@x.com');
    expect(existsSync(path.join(home, 'default-login.original.json'))).toBe(false);
    expect(existsSync(path.join(home, 'default-login.on'))).toBe(false);
  });

  it('chat off leaves no copy of the account behind when Claude had no login of its own before', async () => {
    keychain.items.set(DEFAULT_LOGIN, JSON.stringify({ mcpOAuth: CHATS_MCP }));
    const work = profile('work', 'org-work');
    setActive('work', ctx);
    await setDefaultLoginMode(true, ctx);
    expect(parsed(DEFAULT_LOGIN).claudeAiOauth).toEqual(login('work-token'));

    expect(await setDefaultLoginMode(false, ctx)).toContain('signed out again');
    expect(parsed(DEFAULT_LOGIN)).toEqual({ mcpOAuth: CHATS_MCP });
    expect(parsed(work.dir)).toEqual({ claudeAiOauth: login('work-token') });

    // One signed in again meanwhile left the chats' login the only holder of the one before: that stays.
    await setDefaultLoginMode(true, ctx);
    keychain.items.set(work.dir, stored('work-again'));
    expect(await setDefaultLoginMode(false, ctx)).toBe('chat mode off: your normal Claude login is back as it was');
    expect(parsed(DEFAULT_LOGIN).claudeAiOauth).toEqual(login('work-token'));
    expect(parsed(work.dir)).toEqual({ claudeAiOauth: login('work-again') });
  });

  it("removing a holder's login lets go of the default login, which keeps the chats' login", () => {
    const work = profile('work', 'org-work');
    moveIntoDefaultLogin(work, ctx);
    clearCredential(work.dir);
    expect(existsSync(marker(work.dir))).toBe(false);
    expect(parsed(DEFAULT_LOGIN).claudeAiOauth).toEqual(login('work-token'));
    expect(() => readCredential(credentialPath(work.dir))).toThrow();
  });

  it('does nothing on Windows', () => {
    const work = profile('work', 'org-work');
    expect(moveIntoDefaultLogin(work, { ...ctx, platform: 'win32' }).state).toBe('skipped');
    expect(parsed(DEFAULT_LOGIN).claudeAiOauth).toEqual(login('original'));
    expect(keychain.items.has(work.dir)).toBe(true);
  });

  it('on Linux moves profile login files the same way, keeping MCP logins', () => {
    const linux = { ...ctx, platform: 'linux' as const };
    const fileOf = (dir: string) => path.join(dir, '.credentials.json');
    const work = profile('work', 'org-work');
    const play = profile('play', 'org-play');
    keychain.items.delete(work.dir);
    keychain.items.delete(play.dir);
    writeFileSync(fileOf(work.dir), stored('work-token'));
    writeFileSync(fileOf(play.dir), stored('play-token'));

    expect(moveIntoDefaultLogin(work, linux).state).toBe('moved');
    expect(parsed(DEFAULT_LOGIN).claudeAiOauth).toEqual(login('work-token'));
    expect(parsed(DEFAULT_LOGIN).mcpOAuth).toEqual(CHATS_MCP);
    expect(existsSync(fileOf(work.dir))).toBe(false);
    expect(existsSync(marker(work.dir))).toBe(true);
    expect(state().oauthAccount.emailAddress).toBe('work@x.com');
    expect(JSON.parse(readCredential(credentialPath(work.dir))).claudeAiOauth).toEqual(login('work-token'));

    expect(moveIntoDefaultLogin(play, linux).state).toBe('moved');
    expect(JSON.parse(readFileSync(fileOf(work.dir), 'utf8')).claudeAiOauth).toEqual(login('work-token'));
    expect(existsSync(marker(work.dir))).toBe(false);
    expect(parsed(DEFAULT_LOGIN).claudeAiOauth).toEqual(login('play-token'));
    expect(parsed(DEFAULT_LOGIN).mcpOAuth).toEqual(CHATS_MCP);
    expect(existsSync(fileOf(play.dir))).toBe(false);
    expect(keychain.items.has(work.dir) || keychain.items.has(play.dir)).toBe(false);
  });

  it('never renews the login the chats are using', async () => {
    const work = profile('work', 'org-work');
    moveIntoDefaultLogin(work, ctx);
    // Due for renewal: a profile's own login would be renewed now.
    keychain.items.set(DEFAULT_LOGIN, JSON.stringify({ ...parsed(DEFAULT_LOGIN), claudeAiOauth: login('work-token', { expiresAt: 1 }) }));
    const fetchImpl = vi.fn();
    expect(await refreshCredentialIfExpired(work.dir, { fetchImpl: fetchImpl as unknown as typeof fetch, ctx })).toEqual({
      status: 'not-needed',
      detail: 'renewed by the chats using it',
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    const play = profile('play', 'org-play', JSON.stringify({ claudeAiOauth: login('play-token', { expiresAt: 1 }) }));
    const asked = vi.fn(async () => new Response('down', { status: 503 }));
    await refreshCredentialIfExpired(play.dir, { fetchImpl: asked as unknown as typeof fetch, ctx });
    expect(asked).toHaveBeenCalledTimes(1);
  });
});

describe('chat mode keeps what the logins it moves were promised', () => {
  it("keeps an account's parked MCP sign-ins with the account, never in the chats' login", () => {
    const notion = { accessToken: 'n', expiresAt: 10 };
    const linear = { accessToken: 'l', expiresAt: 20 };
    const work = profile('work', 'org-work', stored('work-token', { mcpOAuth: { notion } }));
    const play = profile('play', 'org-play');
    moveIntoDefaultLogin(work, ctx);
    expect(parsed(DEFAULT_LOGIN).mcpOAuth).toEqual(CHATS_MCP);
    // What a new folder on the account starts from: its parked sign-ins, not the chats'.
    expect(JSON.parse(readCredential(credentialPath(work.dir)))).toEqual({ claudeAiOauth: login('work-token'), mcpOAuth: { notion } });

    // A folder that ends on the account parks its own with the account.
    const ending = JSON.stringify({ claudeAiOauth: login('session'), mcpOAuth: { linear } });
    expect(runBlocking(parkMcpLoginsSteps(work.dir, ending, keychainBlocking))).toBe(true);
    expect(parsed(DEFAULT_LOGIN)).toEqual({ claudeAiOauth: login('work-token'), mcpOAuth: CHATS_MCP, organizationUuid: 'org-work' });
    expect(JSON.parse(readCredential(credentialPath(work.dir))).mcpOAuth).toEqual({ notion, linear });

    // A renewal saved home, written over the stored login: the chats keep theirs, the account its own.
    const saved = JSON.parse(readCredential(credentialPath(work.dir))) as Record<string, unknown>;
    writeCredential(credentialPath(work.dir), JSON.stringify({ ...saved, claudeAiOauth: login('work-renewed') }));
    expect(parsed(DEFAULT_LOGIN)).toEqual({ claudeAiOauth: login('work-renewed'), mcpOAuth: CHATS_MCP, organizationUuid: 'org-work' });
    expect(JSON.parse(readCredential(credentialPath(work.dir)))).toEqual({ claudeAiOauth: login('work-renewed'), mcpOAuth: { notion, linear } });

    // And they go home with the login.
    moveIntoDefaultLogin(play, ctx);
    expect(parsed(work.dir)).toEqual({ claudeAiOauth: login('work-renewed'), mcpOAuth: { notion, linear } });
    expect(parsed(DEFAULT_LOGIN).mcpOAuth).toEqual(CHATS_MCP);
  });

  it('saves a renewal kept when its save failed into the default login, and sends nothing', async () => {
    const work = profile('work', 'org-work');
    moveIntoDefaultLogin(work, ctx);
    expect(keepRenewal(work.dir, stored('work-renewed'), loginTextFingerprint(stored('work-token')))).toBe(true);
    const fetchImpl = vi.fn();
    expect(await refreshCredentialIfExpired(work.dir, { fetchImpl: fetchImpl as unknown as typeof fetch, ctx })).toEqual({
      status: 'refreshed',
      detail: 'saved a renewal kept when its save failed',
    });
    expect(parsed(DEFAULT_LOGIN)).toEqual({ claudeAiOauth: login('work-renewed'), mcpOAuth: CHATS_MCP, organizationUuid: 'org-work' });
    expect(hasKeptRenewal(work.dir)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never writes past the locks Claude takes on its default login and its state", () => {
    const work = profile('work', 'org-work');
    // A chat renewing its login.
    mkdirSync(claudeLock());
    expect(moveIntoDefaultLogin(work, ctx)).toMatchObject({ state: 'busy' });
    expect(parsed(DEFAULT_LOGIN).claudeAiOauth).toEqual(login('original'));
    expect(keychain.items.has(work.dir)).toBe(true);
    expect(existsSync(marker(work.dir))).toBe(false);
    rmdirSync(claudeLock());
    // A chat saving ~/.claude.json.
    mkdirSync(path.join(home, '.claude.json.lock'));
    expect(moveIntoDefaultLogin(work, ctx)).toMatchObject({ state: 'busy' });
    expect(keychain.items.has(work.dir)).toBe(true);
    rmdirSync(path.join(home, '.claude.json.lock'));

    expect(moveIntoDefaultLogin(work, ctx).state).toBe('moved');
    mkdirSync(claudeLock());
    expect(() => writeCredential(credentialPath(work.dir), stored('work-renewed'))).toThrow(/renewing its default login/);
    expect(parsed(DEFAULT_LOGIN).claudeAiOauth).toEqual(login('work-token'));
    rmdirSync(claudeLock());
  });

  it('undoes every step of a move that fails partway', () => {
    const work = profile('work', 'org-work', stored('work-token', { mcpOAuth: { notion: { accessToken: 'n' } } }));
    const play = profile('play', 'org-play');
    moveIntoDefaultLogin(work, ctx);
    // A renewal is written as the stored login with a new Claude login in it, as oauth-refresh writes one.
    const stays = JSON.parse(readCredential(credentialPath(work.dir))) as Record<string, unknown>;
    writeCredential(credentialPath(work.dir), JSON.stringify({ ...stays, claudeAiOauth: login('work-renewed') }));
    const before = {
      login: keychain.items.get(DEFAULT_LOGIN),
      marker: readFileSync(marker(work.dir), 'utf8'),
      state: state(),
    };

    keychain.failRemove = play.dir;
    expect(() => moveIntoDefaultLogin(play, ctx)).toThrow('Could not remove');
    expect(keychain.items.get(DEFAULT_LOGIN)).toBe(before.login);
    expect(readFileSync(marker(work.dir), 'utf8')).toBe(before.marker);
    expect(keychain.items.has(work.dir)).toBe(false);
    expect(parsed(play.dir)).toEqual({ claudeAiOauth: login('play-token') });
    expect(existsSync(marker(play.dir))).toBe(false);
    expect(state()).toEqual(before.state);

    keychain.failRemove = null;
    expect(moveIntoDefaultLogin(play, ctx).state).toBe('moved');
    expect(parsed(work.dir)).toEqual({ claudeAiOauth: login('work-renewed'), mcpOAuth: { notion: { accessToken: 'n' } } });
  });

  it('moves in a login its holder signed in again with', async () => {
    const notion = { accessToken: 'n' };
    const work = profile('work', 'org-work', stored('work-token', { mcpOAuth: { notion } }));
    setActive('work', ctx);
    chatModeOn();
    expect(await followActiveInDefaultLogin(ctx)).toEqual({ state: 'moved', account: 'work' });
    expect(await followActiveInDefaultLogin(ctx)).toEqual({ state: 'already', account: 'work' });

    keychain.items.set(work.dir, stored('work-again'));
    expect(JSON.parse(readCredential(credentialPath(work.dir))).claudeAiOauth).toEqual(login('work-again'));
    expect(await followActiveInDefaultLogin(ctx)).toEqual({ state: 'moved', account: 'work' });
    expect(parsed(DEFAULT_LOGIN).claudeAiOauth).toEqual(login('work-again'));
    expect(keychain.items.has(work.dir)).toBe(false);
    expect(JSON.parse(readCredential(credentialPath(work.dir)))).toEqual({ claudeAiOauth: login('work-again'), mcpOAuth: { notion } });
  });
});

describe('following the active account', () => {
  it('does nothing while chat mode is off', async () => {
    profile('work', 'org-work');
    setActive('work', ctx);
    const before = new Map(keychain.items);
    expect(await followActiveInDefaultLogin(ctx)).toEqual({ state: 'skipped', why: 'chat mode is off' });
    expect(keychain.items).toEqual(before);
  });

  it('looks again while Claude holds its login, and gives up changing nothing', async () => {
    profile('work', 'org-work');
    profile('play', 'org-play');
    setActive('work', ctx);
    chatModeOn();
    mkdirSync(claudeLock());
    const following = followActiveInDefaultLogin(ctx, { retryMs: 10_000, lookMs: 20 });
    await new Promise((r) => setTimeout(r, 100));
    expect(parsed(DEFAULT_LOGIN).claudeAiOauth).toEqual(login('original'));
    rmdirSync(claudeLock());
    expect(await following).toEqual({ state: 'moved', account: 'work' });

    setActive('play', ctx);
    mkdirSync(claudeLock());
    expect(await followActiveInDefaultLogin(ctx, { retryMs: 100, lookMs: 20 })).toMatchObject({ state: 'busy' });
    expect(parsed(DEFAULT_LOGIN).claudeAiOauth).toEqual(login('work-token'));
    rmdirSync(claudeLock());
  });

  it("follows every switch: the editor's move to the active account brings it along", async () => {
    profile('work', 'org-work');
    setActive('work', ctx);
    chatModeOn();
    const context: CliContext = { ctx, config: loadConfig(ctx), out: () => {}, json: false, quiet: false };
    void moveEditorToActive(context);
    await until(() => (parsed(DEFAULT_LOGIN).claudeAiOauth as { accessToken?: string }).accessToken === 'work-token');
    expect(parsed(DEFAULT_LOGIN).claudeAiOauth).toEqual(login('work-token'));
  });

  it("probes the account holding it where its login is, without running Claude on its folder", async () => {
    const work = profile('work', 'org-work', JSON.stringify({ claudeAiOauth: login('work-token', { subscriptionType: 'max' }) }));
    moveIntoDefaultLogin(work, ctx);
    const deps = { claude: { bin: path.join(home, 'no-claude-here'), prefixArgs: [] }, now: () => 7 };
    expect(await probe(work, deps)).toEqual({ name: 'work', checkedAt: 7, loggedIn: true, email: 'work@x.com', plan: 'max' });
    keychain.items.set(DEFAULT_LOGIN, JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '' } }));
    expect(await probe(work, deps)).toMatchObject({ name: 'work', loggedIn: false });
  });
});
