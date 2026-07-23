import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
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
