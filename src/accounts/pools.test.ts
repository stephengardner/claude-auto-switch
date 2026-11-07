import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizePool, poolIndex, storedPool } from './pools.js';
import { addAccount, listAccounts, updateAccount } from './registry.js';
import { TagError } from '../util/errors.js';

describe('a pool name', () => {
  it('is written by the rule a tag is, and refused naming a pool', () => {
    expect(normalizePool('  Lanes ')).toBe('lanes');
    expect(normalizePool('bots.2')).toBe('bots.2');
    for (const bad of ['', 'two words', '-lead', 'x'.repeat(33), 'b@d']) {
      expect(() => normalizePool(bad), JSON.stringify(bad)).toThrow(TagError);
    }
    expect(() => normalizePool('b@d')).toThrow(/is not a pool/);
  });

  it('is read from the file in the form it is compared in, and as none when it is not text', () => {
    expect(storedPool(' Lanes ')).toBe('lanes');
    // A hand edit is kept, to be seen and replaced, as a tag's is.
    expect(storedPool('b@d')).toBe('b@d');
    for (const none of ['', '   ', 3, null, undefined, ['lanes'], { pool: 'x' }])
      expect(storedPool(none)).toBeUndefined();
  });
});

describe('the pools in use', () => {
  it('lists each pool once, sorted, with its accounts in the order given', () => {
    expect(
      poolIndex([
        { name: 'a', pool: 'mine' },
        { name: 'b', pool: 'lanes' },
        { name: 'c' },
        { name: 'd', pool: 'lanes' },
      ]),
    ).toEqual([
      { pool: 'lanes', accounts: ['b', 'd'] },
      { pool: 'mine', accounts: ['a'] },
    ]);
  });
});

describe('a pool on the account record', () => {
  function home() {
    return { env: { CLAUDE_AUTO_SWITCH_HOME: mkdtempSync(path.join(tmpdir(), 'cas-pools-')) } };
  }

  it('is kept through a write of the accounts, and leaves no field when cleared', () => {
    const c = home();
    addAccount({ name: 'a', dir: '/p/a' }, c);
    addAccount({ name: 'b', dir: '/p/b' }, c);
    updateAccount('a', { pool: 'lanes' }, c);
    // Another account's change rewrites the file; the pool stays.
    updateAccount('b', { enabled: false }, c);
    expect(listAccounts(c).map((a) => [a.name, a.pool])).toEqual([
      ['a', 'lanes'],
      ['b', undefined],
    ]);
    updateAccount('a', { pool: undefined }, c);
    const file = readFileSync(path.join(c.env.CLAUDE_AUTO_SWITCH_HOME, 'accounts.json'), 'utf8');
    expect(file).not.toContain('"pool"');
  });

  it('reads as none, with the accounts still readable, when the file holds something that cannot be one', () => {
    const c = home();
    writeFileSync(
      path.join(c.env.CLAUDE_AUTO_SWITCH_HOME, 'accounts.json'),
      JSON.stringify({
        accounts: [{ name: 'a', dir: '/p/a', priority: 0, enabled: true, pool: ['lanes'] }],
      }),
      'utf8',
    );
    expect(listAccounts(c).map((a) => [a.name, a.pool])).toEqual([['a', undefined]]);
  });
});
