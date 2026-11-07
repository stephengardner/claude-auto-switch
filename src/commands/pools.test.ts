import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { poolCommand, poolsCommand, unpoolCommand } from './pools.js';
import { tagCommand, untagCommand } from './tags.js';
import { addAccount, getAccount, updateAccount } from '../accounts/registry.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';

function setup(json: boolean) {
  const ctx = {
    env: { CLAUDE_AUTO_SWITCH_HOME: mkdtempSync(path.join(tmpdir(), 'cas-pool-cmd-')) },
  };
  addAccount({ name: 'a', dir: '/p/a' }, ctx);
  addAccount({ name: 'b', dir: '/p/b' }, ctx);
  const lines: string[] = [];
  const context = {
    ctx,
    config: loadConfig(ctx),
    out: (m: string) => lines.push(m),
    err: () => {},
    json,
    quiet: false,
  } as unknown as CliContext;
  const said = (): unknown => {
    const text = lines.join('\n');
    lines.length = 0;
    return json ? JSON.parse(text) : text;
  };
  return { ctx, context, said };
}

describe('ccx pool and ccx unpool', () => {
  it('put an account in one pool, move it, and take it out, saying each', () => {
    const { ctx, context, said } = setup(false);
    expect(poolCommand(context, 'a', 'Lanes')).toBe(0);
    expect(said()).toBe('"a" is in pool lanes');
    expect(poolCommand(context, 'a', 'mine')).toBe(0);
    expect(said()).toBe('"a" is in pool mine (was lanes)');
    expect(getAccount('a', ctx)?.pool).toBe('mine');
    expect(unpoolCommand(context, 'a')).toBe(0);
    expect(said()).toBe('"a" is in no pool (was mine)');
    expect(getAccount('a', ctx)?.pool).toBeUndefined();
  });

  it('answer in JSON with --json, a refusal too, and write nothing on one', () => {
    const { ctx, context, said } = setup(true);
    expect(poolCommand(context, 'a', 'lanes')).toBe(0);
    expect(said()).toEqual({ schemaVersion: 1, account: 'a', pool: 'lanes', previous: null });
    expect(poolCommand(context, 'a', 'not a pool')).toBe(1);
    expect(said()).toEqual({
      schemaVersion: 1,
      error: expect.stringContaining('"not a pool" is not a pool'),
    });
    expect(getAccount('a', ctx)?.pool).toBe('lanes');
    expect(poolCommand(context, 'nobody', 'lanes')).toBe(1);
    expect(said()).toEqual({ schemaVersion: 1, error: 'account "nobody" not found' });
    expect(unpoolCommand(context, 'a')).toBe(0);
    expect(said()).toEqual({ schemaVersion: 1, account: 'a', pool: null, previous: 'lanes' });
  });
});

describe('ccx pools', () => {
  it('lists each pool with its accounts, and the accounts in none', () => {
    const { ctx, context, said } = setup(true);
    updateAccount('b', { pool: 'lanes', enabled: false }, ctx);
    expect(poolsCommand(context)).toBe(0);
    expect(said()).toEqual({
      schemaVersion: 1,
      pools: [{ pool: 'lanes', accounts: [{ name: 'b', enabled: false }] }],
      unpooled: ['a'],
    });
  });

  it('says so when no account is in a pool', () => {
    const { context, said } = setup(false);
    expect(poolsCommand(context)).toBe(0);
    expect(said()).toBe('no account is in a pool yet (ccx pool <account> <pool>)');
  });
});

describe('ccx tag and ccx untag with --json', () => {
  it('answer with the tags the account carries now', () => {
    const { context, said } = setup(true);
    expect(tagCommand(context, 'a', ['pat', 'Bot'])).toBe(0);
    expect(said()).toEqual({ schemaVersion: 1, account: 'a', tags: ['bot', 'pat'] });
    expect(untagCommand(context, 'a', ['pat'])).toBe(0);
    expect(said()).toEqual({ schemaVersion: 1, account: 'a', tags: ['bot'] });
    expect(untagCommand(context, 'a', [], { all: true })).toBe(0);
    expect(said()).toEqual({ schemaVersion: 1, account: 'a', tags: [] });
  });

  it('refuse in the same envelope', () => {
    const { context, said } = setup(true);
    expect(tagCommand(context, 'a', ['b@d'])).toBe(1);
    expect(said()).toEqual({ schemaVersion: 1, error: expect.stringContaining('is not a tag') });
    expect(untagCommand(context, 'a', [])).toBe(1);
    expect(said()).toEqual({
      schemaVersion: 1,
      error: 'name the tags to remove, or --all to remove every one',
    });
  });
});
