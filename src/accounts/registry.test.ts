import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  addAccount,
  getAccount,
  listAccounts,
  updateAccount,
  removeAccount,
} from './registry.js';
import { RegistryError } from '../util/errors.js';

function home() {
  return { env: { CLAUDE_AUTO_SWITCH_HOME: mkdtempSync(path.join(tmpdir(), 'cas-reg-')) } };
}

describe('registry', () => {
  it('adds accounts with ascending priority and lists them', () => {
    const ctx = home();
    addAccount({ name: 'a', dir: '/a' }, ctx);
    addAccount({ name: 'b', dir: '/b' }, ctx);
    const list = listAccounts(ctx);
    expect(list.map((x) => x.name)).toEqual(['a', 'b']);
    expect(list[0]?.priority).toBe(0);
    expect(list[1]?.priority).toBe(1);
    expect(list[0]?.enabled).toBe(true);
  });

  it('rejects a duplicate name', () => {
    const ctx = home();
    addAccount({ name: 'a', dir: '/a' }, ctx);
    expect(() => addAccount({ name: 'a', dir: '/a2' }, ctx)).toThrow(RegistryError);
  });

  it('gets a single account or undefined', () => {
    const ctx = home();
    addAccount({ name: 'a', dir: '/a', plan: 'max' }, ctx);
    expect(getAccount('a', ctx)?.plan).toBe('max');
    expect(getAccount('missing', ctx)).toBeUndefined();
  });

  it('updates an account but keeps its name', () => {
    const ctx = home();
    addAccount({ name: 'a', dir: '/a' }, ctx);
    const updated = updateAccount('a', { enabled: false, plan: 'free', name: 'hacked' }, ctx);
    expect(updated.name).toBe('a');
    expect(updated.enabled).toBe(false);
    expect(updated.plan).toBe('free');
    expect(getAccount('a', ctx)?.enabled).toBe(false);
  });

  it('throws updating a missing account', () => {
    const ctx = home();
    expect(() => updateAccount('nope', { enabled: false }, ctx)).toThrow(RegistryError);
  });

  it('removes an account and throws when it does not exist', () => {
    const ctx = home();
    addAccount({ name: 'a', dir: '/a' }, ctx);
    removeAccount('a', ctx);
    expect(getAccount('a', ctx)).toBeUndefined();
    expect(() => removeAccount('a', ctx)).toThrow(RegistryError);
  });
});

describe('tags on an account', () => {
  it('are stored on its record, and taken at creation', () => {
    const ctx = home();
    addAccount({ name: 'a', dir: '/a', tags: ['bot'] }, ctx);
    updateAccount('a', { tags: ['bot', 'pat'] }, ctx);
    expect(getAccount('a', ctx)?.tags).toEqual(['bot', 'pat']);
  });

  it('are left out of the record when there are none', () => {
    const ctx = home();
    addAccount({ name: 'a', dir: '/a', tags: [] }, ctx);
    expect('tags' in (getAccount('a', ctx) ?? {})).toBe(false);
  });

  it('never make the registry unreadable when the file holds something that is not a list of tags', () => {
    // Tags are checked where they are typed (accounts/tags). A hand-edited
    // file is read as no tags rather than failing every command that loads
    // the accounts.
    const ctx = home();
    addAccount({ name: 'a', dir: '/a' }, ctx);
    const file = path.join(ctx.env.CLAUDE_AUTO_SWITCH_HOME, 'accounts.json');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { accounts: Array<Record<string, unknown>> };
    raw.accounts[0]!['tags'] = 'pat';
    writeFileSync(file, JSON.stringify(raw), 'utf8');
    expect(listAccounts(ctx).map((x) => [x.name, x.tags])).toEqual([['a', undefined]]);
  });
});

describe('a field this version does not know', () => {
  it('survives a write, so a newer ccx does not lose it to this one', () => {
    const ctx = home();
    addAccount({ name: 'a', dir: '/a' }, ctx);
    const file = path.join(ctx.env.CLAUDE_AUTO_SWITCH_HOME, 'accounts.json');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { accounts: Array<Record<string, unknown>>; [k: string]: unknown };
    raw.accounts[0]!['fromTheFuture'] = { kept: true };
    raw['alsoNew'] = 1;
    writeFileSync(file, JSON.stringify(raw), 'utf8');
    updateAccount('a', { enabled: false }, ctx);
    const after = JSON.parse(readFileSync(file, 'utf8')) as { accounts: Array<Record<string, unknown>>; [k: string]: unknown };
    expect(after.accounts[0]?.['fromTheFuture']).toEqual({ kept: true });
    expect(after['alsoNew']).toBe(1);
  });
});
