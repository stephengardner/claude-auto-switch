import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renameAccount } from './rename.js';
import { addAccount, getAccount, listAccounts } from './registry.js';
import { getActive, setActive } from '../state/active.js';
import { loadLedger, saveLedger } from '../ledger/ledger.js';
import { readUsageSnapshot, writeUsageSnapshot } from '../usage/usage-store.js';
import { takeLease } from '../session/lease.js';

const config = {};

function setup(names: string[]) {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-rename-'));
  const c = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  for (const name of names) {
    const dir = path.join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.credentials.json'), '{}', 'utf8');
    addAccount({ name, dir }, c);
  }
  return { c, home };
}

describe('renameAccount', () => {
  it('renames the account and moves its folder to match', () => {
    const { c, home } = setup(['old']);
    const r = renameAccount('old', 'new', config, c);

    expect(r.folderMoved).toBe(true);
    expect(getAccount('new', c)?.dir).toBe(path.join(home, 'profiles', 'new'));
    expect(getAccount('old', c)).toBeUndefined();
    // The folder really moved, taking the login with it.
    expect(existsSync(path.join(home, 'profiles', 'new', '.credentials.json'))).toBe(true);
    expect(existsSync(path.join(home, 'profiles', 'old'))).toBe(false);
  });

  it('carries the limit history and usage numbers across', () => {
    // Leaving these behind under the old name reads as "my usage reset itself".
    const { c } = setup(['old']);
    const ledger = loadLedger(c);
    ledger.caps.push({ account: 'old', capUntil: 123, reason: 'test', at: 1 });
    saveLedger(ledger, c);
    const usage = readUsageSnapshot(c);
    usage.accounts['old'] = { fiveHour: 0.4, sevenDay: 0.5, fiveHourReset: null, sevenDayReset: null, at: 9 };
    writeUsageSnapshot(usage, c);

    renameAccount('old', 'new', config, c);

    expect(loadLedger(c).caps.map((x) => x.account)).toEqual(['new']);
    expect(readUsageSnapshot(c).accounts['new']?.fiveHour).toBe(0.4);
    expect(readUsageSnapshot(c).accounts['old']).toBeUndefined();
  });

  it('follows the rename with the active pointer', () => {
    const { c } = setup(['old', 'other']);
    setActive('old', c);
    renameAccount('old', 'new', config, c);
    expect(getActive(c)).toBe('new');
  });

  it('leaves a different active account alone', () => {
    const { c } = setup(['old', 'other']);
    setActive('other', c);
    renameAccount('old', 'new', config, c);
    expect(getActive(c)).toBe('other');
  });

  it('refuses a name another account already has', () => {
    const { c } = setup(['one', 'two']);
    expect(() => renameAccount('one', 'two', config, c)).toThrow(/already exists/);
    expect(listAccounts(c).map((a) => a.name)).toEqual(['one', 'two']); // nothing changed
  });

  it('refuses a name that is not usable as a folder', () => {
    const { c } = setup(['one']);
    expect(() => renameAccount('one', 'bad/name', config, c)).toThrow();
    expect(() => renameAccount('one', '..', config, c)).toThrow();
    expect(getAccount('one', c)).toBeDefined();
  });

  it('refuses renaming to the same name', () => {
    const { c } = setup(['one']);
    expect(() => renameAccount('one', 'one', config, c)).toThrow(/already has that name/);
  });

  it('refuses an account that does not exist', () => {
    const { c } = setup(['one']);
    expect(() => renameAccount('nope', 'other', config, c)).toThrow(/not found/);
  });

  it('renames but keeps the folder while a session is using it', () => {
    const { c, home } = setup(['busy']);
    takeLease('busy', path.join(home, 'session'), c);

    const r = renameAccount('busy', 'renamed', config, c);

    expect(getAccount('renamed', c)).toBeDefined();
    expect(r.folderMoved).toBe(false);
    expect(r.folderNote).toContain('session is using it');
    // Moving it under a running session would break that session's login.
    expect(getAccount('renamed', c)?.dir).toBe(path.join(home, 'profiles', 'busy'));
    expect(existsSync(path.join(home, 'profiles', 'busy'))).toBe(true);
  });

  it('keeps a folder that lives somewhere custom', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-rename-'));
    const c = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
    const custom = path.join(home, 'profiles', 'somewhere-else');
    mkdirSync(custom, { recursive: true });
    addAccount({ name: 'one', dir: custom }, c);

    const r = renameAccount('one', 'two', config, c);

    expect(r.folderMoved).toBe(false);
    expect(r.folderNote).toContain('custom location');
    expect(getAccount('two', c)?.dir).toBe(custom);
  });

  it('puts the folder back if the registry write fails', () => {
    // The dangerous order: the folder has already moved, then recording it fails.
    // Left alone, the registry still says the old name and the old path, so the
    // account looks intact while its login sits somewhere nothing points at.
    const { c, home } = setup(['old']);
    const boom = () => {
      throw new Error('disk full');
    };

    expect(() => renameAccount('old', 'new', config, c, { saveRegistry: boom })).toThrow(
      /disk full/,
    );

    // Back where it started, with the login where the registry still points.
    expect(existsSync(path.join(home, 'profiles', 'old', '.credentials.json'))).toBe(true);
    expect(existsSync(path.join(home, 'profiles', 'new'))).toBe(false);
    expect(getAccount('old', c)?.dir).toBe(path.join(home, 'profiles', 'old'));
  });

  it('keeps the folder when one with the new name already exists', () => {
    const { c, home } = setup(['old']);
    mkdirSync(path.join(home, 'profiles', 'taken'), { recursive: true });
    const r = renameAccount('old', 'taken', config, c);
    expect(r.folderMoved).toBe(false);
    expect(r.folderNote).toContain('already exists');
    // The old folder, and whatever is in it, is untouched.
    expect(existsSync(path.join(home, 'profiles', 'old', '.credentials.json'))).toBe(true);
  });
});
