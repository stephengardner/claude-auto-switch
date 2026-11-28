import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { accountAddresses, accountEmail } from './account-email.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** A profile folder that claims, in its own `.claude.json`, to be `claims`. */
function profile(claims?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-acct-email-profile-'));
  made.push(dir);
  if (claims !== undefined) {
    writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: claims } }),
      'utf8',
    );
  }
  return dir;
}

describe('accountEmail: the address an account reports, else its record', () => {
  it('is the address its login check reports while it is signed in', () => {
    expect(accountEmail({ email: 'recorded@example.com' }, 'live@example.com')).toBe(
      'live@example.com',
    );
  });

  it('is the address recorded for it once it is signed out', () => {
    expect(accountEmail({ email: 'recorded@example.com' })).toBe('recorded@example.com');
    expect(accountEmail({ email: 'recorded@example.com' }, null)).toBe('recorded@example.com');
  });

  it('is nothing when neither is known', () => {
    expect(accountEmail({})).toBeUndefined();
  });

  it('takes a blank address for none', () => {
    expect(accountEmail({ email: '  ' }, '')).toBeUndefined();
    expect(accountEmail({ email: 'recorded@example.com' }, ' ')).toBe('recorded@example.com');
  });
});

describe('accountAddresses: the reported or recorded address, else the unchecked claim', () => {
  it('gives a reported or recorded address and no claim beside it, reading no profile', () => {
    // The usual signed-in profile: its own claim IS the reported address.
    const readClaim = vi.fn(() => 'work@example.com');
    const addresses = accountAddresses(
      [
        { name: 'work', dir: 'unused-1' },
        { name: 'kept', dir: 'unused-2', email: 'kept@example.com' },
      ],
      new Map([['work', 'work@example.com']]),
      readClaim,
    );
    expect(addresses.get('work')).toEqual({ email: 'work@example.com' });
    expect(addresses.get('kept')).toEqual({ email: 'kept@example.com' });
    expect(readClaim).not.toHaveBeenCalled();
  });

  it('gives a signed-out account with nothing recorded its claim, as a claim only', () => {
    const addresses = accountAddresses(
      [{ name: 'out', dir: profile('claimed@example.com') }],
      new Map(),
    );
    expect(addresses.get('out')).toEqual({ claimedEmail: 'claimed@example.com' });
  });

  it('leaves out a claim another account is recorded as', () => {
    // A refused sign-in puts the credential back but leaves the profile
    // claiming the twin it was refused for.
    const addresses = accountAddresses(
      [
        { name: 'a', dir: profile(), email: 'Twin@example.com' },
        { name: 'b', dir: profile('twin@example.com') },
      ],
      new Map(),
    );
    expect(addresses.get('b')).toEqual({});
  });

  it('leaves out a claim another account is signed in as', () => {
    const addresses = accountAddresses(
      [
        { name: 'a', dir: profile() },
        { name: 'b', dir: profile('twin@example.com') },
      ],
      new Map([['a', 'TWIN@example.com']]),
    );
    expect(addresses.get('a')).toEqual({ email: 'TWIN@example.com' });
    expect(addresses.get('b')).toEqual({});
  });

  it('leaves out a claim two accounts with nothing reported or recorded both make', () => {
    // ccx refuses a second profile on one login and leaves that profile
    // claiming the address, so which of the two holds it is not known.
    const addresses = accountAddresses(
      [
        { name: 'a', dir: profile('dup@example.com') },
        { name: 'b', dir: profile('DUP@example.com') },
        { name: 'c', dir: profile('own@example.com') },
      ],
      new Map(),
    );
    expect(addresses.get('a')).toEqual({});
    expect(addresses.get('b')).toEqual({});
    expect(addresses.get('c')).toEqual({ claimedEmail: 'own@example.com' });
  });

  it('gives nothing when nothing knows it', () => {
    const silent = profile();
    writeFileSync(path.join(silent, '.claude.json'), JSON.stringify({ theme: 'dark' }), 'utf8');
    const addresses = accountAddresses(
      [
        { name: 'bare', dir: profile() },
        { name: 'silent', dir: silent },
        { name: 'gone', dir: path.join(silent, 'no-such-folder') },
        { name: 'blank', dir: profile('   ') },
      ],
      new Map(),
    );
    expect([...addresses.values()]).toEqual([{}, {}, {}, {}]);
  });
});
