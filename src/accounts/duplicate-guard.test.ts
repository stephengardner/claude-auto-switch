import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  sharedLoginGroups,
  renewalWouldBreakOthers,
  carryTargets,
  profileAlreadyHolding,
} from './duplicate-guard.js';

/**
 * Two profiles holding one account is not a tidiness problem. Renewing a login
 * rotates it, so renewing either one ends the other, and the account is gone
 * until it is signed in again. These are the checks that keep that from
 * happening, so they matter more than most.
 */

function profile(name: string, tokens: { access?: string; refresh?: string } | null): { name: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-dup-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify(
      tokens
        ? { claudeAiOauth: { accessToken: tokens.access ?? '', refreshToken: tokens.refresh ?? '' } }
        : {},
    ),
    'utf8',
  );
  return { name, dir };
}

describe('spotting profiles that share a login', () => {
  it('groups profiles holding the same refresh token', () => {
    const a = profile('a', { access: 'ta', refresh: 'shared' });
    const b = profile('b', { access: 'tb', refresh: 'shared' });
    const c = profile('c', { access: 'tc', refresh: 'own' });
    const groups = sharedLoginGroups([a, b, c]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.names.sort()).toEqual(['a', 'b']);
  });

  it('never puts a token in the result, only a fingerprint', () => {
    const groups = sharedLoginGroups([
      profile('a', { refresh: 'super-secret-token' }),
      profile('b', { refresh: 'super-secret-token' }),
    ]);
    expect(JSON.stringify(groups)).not.toContain('super-secret-token');
  });

  it('finds nothing when every profile has its own login, or none at all', () => {
    expect(sharedLoginGroups([profile('a', { refresh: 'x' }), profile('b', { refresh: 'y' })])).toEqual([]);
    expect(sharedLoginGroups([profile('a', null), profile('b', null)])).toEqual([]);
    expect(sharedLoginGroups([])).toEqual([]);
  });
});

describe('refusing a renewal that would end another login', () => {
  it('names the profiles that would be broken', () => {
    const a = profile('a', { refresh: 'shared' });
    const b = profile('b', { refresh: 'shared' });
    const c = profile('c', { refresh: 'own' });
    expect(renewalWouldBreakOthers(a, [a, b, c])).toEqual(['b']);
    expect(renewalWouldBreakOthers(c, [a, b, c])).toEqual([]);
  });

  it('says nothing would break when there is no login to rotate', () => {
    const a = profile('a', null);
    expect(renewalWouldBreakOthers(a, [a, profile('b', { refresh: 'x' })])).toEqual([]);
  });
});

describe('refusing a login that duplicates another profile', () => {
  const accounts = [
    { name: 'work', dir: 'd1', email: 'Work@Example.com' },
    { name: 'personal', dir: 'd2', email: 'personal@example.com' },
  ];

  it('spots the duplicate regardless of case', () => {
    expect(profileAlreadyHolding('work@example.com', accounts, 'personal')).toBe('work');
    expect(profileAlreadyHolding('  WORK@EXAMPLE.COM  ', accounts, 'personal')).toBe('work');
  });

  it('does not count the profile being signed in as its own duplicate', () => {
    expect(profileAlreadyHolding('work@example.com', accounts, 'work')).toBeNull();
  });

  it('allows an account nobody else holds', () => {
    expect(profileAlreadyHolding('third@example.com', accounts, 'work')).toBeNull();
    expect(profileAlreadyHolding('', accounts, 'work')).toBeNull();
  });
});

describe('two profiles holding one token that are NOT the same account', () => {
  /** Same helper, plus the account each profile is registered FOR. */
  function owned(name: string, refresh: string, email?: string) {
    return { ...profile(name, { refresh }), ...(email ? { email } : {}) };
  }

  it('still counts them for renewal SAFETY: rotation kills the token, whoever holds it', () => {
    // Protection follows the token. A contaminated sibling loses the login
    // physically when the token rotates, so leaving it out of this answer
    // would let a renewal sign a live session out.
    const main = owned('main', 'shared', 'stephen@shopsheriff.com');
    const phx = owned('phx', 'shared', 'stephen@phoenixtechnologies.io');
    expect(renewalWouldBreakOthers(main, [main, phx])).toEqual(['phx']);
  });

  it('does not CARRY the renewal across to them', () => {
    // This is contamination, not sharing, and carrying the renewal across is
    // what made it permanent: once two profiles held one token, every renewal
    // copied the new one over the sibling, so they could never come apart and
    // signing in again was undone minutes later by the next renewal.
    const main = owned('main', 'shared', 'stephen@shopsheriff.com');
    const phx = owned('phx', 'shared', 'stephen@phoenixtechnologies.io');
    expect(carryTargets(main, [main, phx])).toEqual([]);
  });

  it('carries across for a genuine duplicate of the SAME account', () => {
    // The case the carry exists for: signing in twice while the browser is
    // still signed in gives one account two profiles, and renewing either one
    // would otherwise kill the other.
    const one = owned('one', 'shared', 'same@example.com');
    const two = owned('two', 'shared', 'same@example.com');
    expect(carryTargets(one, [one, two])).toEqual(['two']);
    expect(renewalWouldBreakOthers(one, [one, two])).toEqual(['two']);
  });

  it('carries across when an account is unregistered, rather than guessing', () => {
    // Not knowing who a profile is for cannot rule out that they match, and
    // refusing on unknown would break the duplicate case this protects.
    const known = owned('known', 'shared', 'same@example.com');
    const nameless = owned('nameless', 'shared');
    expect(carryTargets(known, [known, nameless])).toEqual(['nameless']);
  });
});
