import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addAccount, getAccount, listAccounts } from '../accounts/registry.js';
import { credentialPath, installCredential } from '../accounts/credential-vault.js';
import { decideSaveBack } from '../accounts/save-back.js';
import { getActive, setActive } from '../state/active.js';
import { readTarget, setTarget } from '../daemon/junction.js';
import { loadConfig } from '../config/config.js';
import { removeCommand } from './remove.js';
import type { CliContext } from '../context.js';
import type { SessionLease } from '../session/lease.js';

// Never the machine's real Keychain: a login here is a file in a temp folder.
vi.mock('../accounts/keychain.js', () => ({
  readKeychainCredential: () => null,
  writeKeychainCredential: () => {
    throw new Error('no Keychain in tests');
  },
  deleteKeychainCredential: () => {},
}));

const login = (token: string): string =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: token,
      refreshToken: `refresh-${token}`,
      expiresAt: Date.now() + 3_600_000,
    },
  });

function setup(names: string[] = ['work', 'spare']) {
  const home = mkdtempSync(path.join(tmpdir(), 'ccx-remove-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  const said: string[] = [];
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    out: (m: string) => said.push(m),
    err: () => {},
    json: false,
    quiet: false,
  };
  const dirOf = (name: string): string => path.join(home, 'profiles', name);
  for (const name of names) {
    mkdirSync(dirOf(name), { recursive: true });
    writeFileSync(credentialPath(dirOf(name)), login(name), 'utf8');
    addAccount({ name, dir: dirOf(name) }, ctx);
  }
  const editorLink = path.join(home, 'editor-active');
  return { home, ctx, context, said, dirOf, editorLink };
}

const lease = (pid: number, account: string, cwd: string): SessionLease => ({
  pid,
  account,
  configDir: path.join('sessions', String(pid)),
  cwd,
  at: 1,
});
const nothingRunning = (): SessionLease[] => [];

describe('ccx remove', () => {
  it('says so when there is no such account', () => {
    const { context, said } = setup();
    expect(removeCommand(context, 'nobody', {}, nothingRunning)).toBe(1);
    expect(said).toEqual(['account "nobody" not found']);
  });

  it('removes the active account, clears the pin, and keeps its folder and login', () => {
    const { context, ctx, said, dirOf } = setup();
    setActive('work', ctx);
    expect(removeCommand(context, 'work', {}, nothingRunning)).toBe(0);
    expect(getAccount('work', ctx)).toBeUndefined();
    expect(getActive(ctx)).toBeNull();
    expect(existsSync(credentialPath(dirOf('work')))).toBe(true);
    expect(said).toEqual([`removed "work" (profile folder kept at ${dirOf('work')})`]);
  });

  it('leaves the pin alone when another account holds it', () => {
    const { context, ctx } = setup();
    setActive('spare', ctx);
    expect(removeCommand(context, 'work', {}, nothingRunning)).toBe(0);
    expect(getActive(ctx)).toBe('spare');
  });

  it('removes the last account, leaving none', () => {
    const { context, ctx } = setup(['only']);
    setActive('only', ctx);
    expect(removeCommand(context, 'only', {}, nothingRunning)).toBe(0);
    expect(listAccounts(ctx)).toEqual([]);
    expect(getActive(ctx)).toBeNull();
  });

  it('removes an account a session is running on, keeping the folder that session saves its login to', () => {
    const { context, ctx, dirOf } = setup();
    expect(removeCommand(context, 'work', {}, () => [lease(11, 'work', '/w/api')])).toBe(0);
    expect(getAccount('work', ctx)).toBeUndefined();
    expect(existsSync(credentialPath(dirOf('work')))).toBe(true);
  });

  it("removes the editor's account without breaking the editor: its pointer still reaches the kept folder", () => {
    const { context, ctx, dirOf, editorLink } = setup();
    setActive('work', ctx);
    setTarget(editorLink, dirOf('work'));
    expect(removeCommand(context, 'work', {}, nothingRunning)).toBe(0);
    expect(getAccount('work', ctx)).toBeUndefined();
    expect(existsSync(path.join(editorLink, path.basename(credentialPath(dirOf('work')))))).toBe(
      true,
    );
  });
});

describe('ccx remove --purge', () => {
  it('deletes the folder and the login in it when nothing is using them', () => {
    const { context, ctx, said, dirOf } = setup();
    expect(removeCommand(context, 'spare', { purge: true }, nothingRunning)).toBe(0);
    expect(getAccount('spare', ctx)).toBeUndefined();
    expect(existsSync(dirOf('spare'))).toBe(false);
    expect(said).toEqual([`removed "spare" and purged ${dirOf('spare')}`]);
  });

  it('removes nothing while a session is running on the account', () => {
    const { context, ctx, said, dirOf } = setup();
    setActive('work', ctx);
    expect(
      removeCommand(context, 'work', { purge: true }, () => [lease(11, 'work', '/w/api')]),
    ).toBe(1);
    expect(getAccount('work', ctx)?.dir).toBe(dirOf('work'));
    expect(getActive(ctx)).toBe('work');
    expect(existsSync(credentialPath(dirOf('work')))).toBe(true);
    expect(said.join('\n')).toContain(
      '"work" was not removed: its folder cannot be deleted while 1 session is running on it.',
    );
  });

  it('is not held up by a session on another account', () => {
    const { context, dirOf } = setup();
    expect(
      removeCommand(context, 'spare', { purge: true }, () => [lease(11, 'work', '/w/api')]),
    ).toBe(0);
    expect(existsSync(dirOf('spare'))).toBe(false);
  });

  it('removes nothing while the editor is on the account, so its pointer never dangles', () => {
    const { context, ctx, said, dirOf, editorLink } = setup();
    setTarget(editorLink, dirOf('work'));
    expect(removeCommand(context, 'work', { purge: true }, nothingRunning)).toBe(1);
    expect(getAccount('work', ctx)?.dir).toBe(dirOf('work'));
    expect(existsSync(path.resolve(readTarget(editorLink)!))).toBe(true);
    expect(said.join('\n')).toContain('its folder cannot be deleted while your editor is on it.');
  });

  it("removes nothing while the daemon's link is on the account, which every Claude outside ccx reads", () => {
    const { context, ctx, said, home, dirOf } = setup();
    const daemonLink = path.join(home, 'active');
    setTarget(daemonLink, dirOf('work'));
    expect(removeCommand(context, 'work', { purge: true }, nothingRunning)).toBe(1);
    expect(getAccount('work', ctx)?.dir).toBe(dirOf('work'));
    expect(existsSync(path.resolve(readTarget(daemonLink)!))).toBe(true);
    expect(said.join('\n')).toContain(
      "its folder cannot be deleted while the daemon's link is on it.",
    );
  });

  it('removes nothing while another account is registered on the same folder, whose login would go with it', () => {
    const { context, ctx, said, dirOf } = setup();
    addAccount({ name: 'twin', dir: dirOf('work') }, ctx);
    // With a session on the other account, and with nothing running at all.
    for (const running of [[lease(11, 'work', '/w/api')], []]) {
      expect(removeCommand(context, 'twin', { purge: true }, () => running)).toBe(1);
      expect(getAccount('twin', ctx)).toBeDefined();
      expect(existsSync(credentialPath(dirOf('work')))).toBe(true);
    }
    expect(said.join('\n')).toContain(
      'its folder cannot be deleted while "work" keeps its login there.',
    );
  });

  it('removes nothing while another account keeps its folder inside this one, and deletes the inner one alone', () => {
    const { context, ctx, dirOf } = setup();
    const inside = path.join(dirOf('work'), 'nested');
    mkdirSync(inside);
    writeFileSync(credentialPath(inside), login('nested'), 'utf8');
    addAccount({ name: 'nested', dir: inside }, ctx);
    expect(removeCommand(context, 'work', { purge: true }, nothingRunning)).toBe(1);
    expect(getAccount('work', ctx)).toBeDefined();
    expect(existsSync(credentialPath(inside))).toBe(true);

    expect(removeCommand(context, 'nested', { purge: true }, nothingRunning)).toBe(0);
    expect(existsSync(inside)).toBe(false);
    expect(existsSync(credentialPath(dirOf('work')))).toBe(true);
  });

  it('removes nothing when the two share a folder through a link, from either side', () => {
    // Purging the link's own account would clear the login through the link;
    // purging the other would delete the folder the link lands on.
    const { context, ctx, home, dirOf } = setup();
    const alias = path.join(home, 'profiles', 'twin');
    setTarget(alias, dirOf('work'));
    addAccount({ name: 'twin', dir: alias }, ctx);
    for (const name of ['twin', 'work']) {
      expect(removeCommand(context, name, { purge: true }, nothingRunning)).toBe(1);
      expect(getAccount(name, ctx)).toBeDefined();
      expect(existsSync(credentialPath(dirOf('work')))).toBe(true);
      expect(existsSync(credentialPath(alias))).toBe(true);
    }
  });

  it('still removes an account on a shared folder without --purge, leaving the folder to the other', () => {
    const { context, ctx, dirOf } = setup();
    addAccount({ name: 'twin', dir: dirOf('work') }, ctx);
    expect(removeCommand(context, 'twin', {}, nothingRunning)).toBe(0);
    expect(getAccount('twin', ctx)).toBeUndefined();
    expect(getAccount('work', ctx)?.dir).toBe(dirOf('work'));
    expect(existsSync(credentialPath(dirOf('work')))).toBe(true);
  });

  it('refuses the same way for a folder outside the profiles tree, whose login it would clear', () => {
    const { context, ctx, home } = setup();
    const elsewhere = path.join(home, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(credentialPath(elsewhere), login('custom'), 'utf8');
    addAccount({ name: 'custom', dir: elsewhere }, ctx);
    expect(
      removeCommand(context, 'custom', { purge: true }, () => [lease(11, 'custom', '/w/api')]),
    ).toBe(1);
    expect(existsSync(credentialPath(elsewhere))).toBe(true);
    expect(getAccount('custom', ctx)).toBeDefined();
  });

  it('waits for sessions because one saving its login back recreates a deleted folder', () => {
    // What a running session does when its login is renewed and when it ends:
    // the purge would be undone, and the account it restored no longer listed.
    // The check in front of that save goes by the address the account was
    // registered with, so a folder that is gone does not stop it.
    expect(
      decideSaveBack({
        sessionEmail: 'work@example.com',
        accountEmail: 'work@example.com',
        sessionIdentity: 'the session',
        accountIdentity: null,
        accountName: 'work',
      }),
    ).toEqual({ save: true });
    const { home, dirOf } = setup();
    const sessionLogin = path.join(
      home,
      'sessions',
      '11',
      path.basename(credentialPath(dirOf('work'))),
    );
    mkdirSync(path.dirname(sessionLogin), { recursive: true });
    writeFileSync(sessionLogin, login('work-renewed'), 'utf8');
    rmSync(dirOf('work'), { recursive: true, force: true });
    expect(installCredential(dirOf('work'), sessionLogin)).toBe(true);
    expect(existsSync(credentialPath(dirOf('work')))).toBe(true);
  });
});
