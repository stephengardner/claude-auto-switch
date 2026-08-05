import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { propagateRenewal, snapshotSharing } from './shared-login.js';
import { credentialFingerprint } from './credential-vault.js';

function profile(home: string, name: string, oauth: Record<string, unknown>) {
  const dir = path.join(home, 'profiles', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }), 'utf8');
  return { name, dir };
}

function refreshTokenOf(dir: string): string {
  return (
    JSON.parse(readFileSync(path.join(dir, '.credentials.json'), 'utf8')) as {
      claudeAiOauth: { refreshToken: string };
    }
  ).claudeAiOauth.refreshToken;
}

/** Two profiles holding one login, as a duplicate sign-in produces. */
function sharedPair() {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-shared-'));
  const shared = { accessToken: 'sk-old', refreshToken: 'refresh-shared', expiresAt: 1 };
  const renewed = profile(home, 'phx', { ...shared });
  const sibling = profile(home, 'maxed', { ...shared });
  const retired = credentialFingerprint(renewed.dir);
  return { home, renewed, sibling, retired };
}

/** Stand in for the renewal: replace the login with a rotated one. */
function renew(dir: string): void {
  writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-new', refreshToken: 'refresh-rotated', expiresAt: 999 },
    }),
    'utf8',
  );
}

describe('a login shared by two profiles, when one of them renews', () => {
  it('carries the new login across, so the other one keeps working', () => {
    // The death this prevents: renewing rotates the token and retires the old
    // one immediately, so the sibling is finished the moment this happens. It
    // is the same account, so it should hold the same login.
    const { renewed, sibling, retired } = sharedPair();
    renew(renewed.dir);

    expect(propagateRenewal(renewed.dir, [sibling], retired)).toEqual(['maxed']);
    expect(refreshTokenOf(sibling.dir)).toBe('refresh-rotated');
  });

  it('keeps the sibling previous login as a rollback cushion', () => {
    const { renewed, sibling, retired } = sharedPair();
    renew(renewed.dir);
    propagateRenewal(renewed.dir, [sibling], retired);
    expect(existsSync(path.join(sibling.dir, '.credentials.prev.json'))).toBe(true);
  });

  it('does NOT touch a profile holding a different login', () => {
    // The precondition that makes this safe to do automatically. Writing over a
    // profile that is not the one that just got retired would be a guess about
    // someone's login, and guessing scrambled these profiles once before.
    const { home, renewed, retired } = sharedPair();
    const other = profile(home, 'second', {
      accessToken: 'sk-other',
      refreshToken: 'refresh-someone-else',
      expiresAt: 5,
    });
    renew(renewed.dir);

    expect(propagateRenewal(renewed.dir, [other], retired)).toEqual([]);
    expect(refreshTokenOf(other.dir)).toBe('refresh-someone-else');
  });

  it('does nothing when there is no fingerprint to match on', () => {
    const { renewed, sibling } = sharedPair();
    renew(renewed.dir);
    expect(propagateRenewal(renewed.dir, [sibling], null)).toEqual([]);
    expect(refreshTokenOf(sibling.dir)).toBe('refresh-shared');
  });

  it('never writes over the profile that was renewed', () => {
    // Checked BEFORE the renewal on purpose. Afterwards this profile no longer
    // matches the retired fingerprint, so the exact-match check would refuse it
    // anyway and the guard would prove nothing. Before the renewal it still
    // matches, so only the self-check stops it copying a file onto itself.
    const { renewed, retired } = sharedPair();
    expect(propagateRenewal(renewed.dir, [renewed], retired)).toEqual([]);
    expect(refreshTokenOf(renewed.dir)).toBe('refresh-shared');
  });

  it('carries on when one profile cannot be written', () => {
    // One unwritable profile must not strand the others: a login left behind is
    // exactly the failure being fixed.
    const { home, renewed, sibling, retired } = sharedPair();
    const broken = { name: 'broken', dir: path.join(home, 'profiles', 'broken') };
    mkdirSync(broken.dir, { recursive: true });
    writeFileSync(
      path.join(broken.dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-old', refreshToken: 'refresh-shared' } }),
      'utf8',
    );
    renew(renewed.dir);

    const updated = propagateRenewal(renewed.dir, [broken, sibling], retired);
    expect(updated).toContain('maxed');
  });
});

describe('the order of taking the snapshot', () => {
  it('works when taken BEFORE the renewal', () => {
    const { renewed, sibling, home } = sharedPair();
    const accounts = [renewed, sibling];
    const snapshot = snapshotSharing(renewed, accounts, ['maxed']);
    renew(renewed.dir);

    expect(propagateRenewal(renewed.dir, snapshot.sharedWith, snapshot.fingerprint)).toEqual(['maxed']);
    expect(refreshTokenOf(sibling.dir)).toBe('refresh-rotated');
    expect(home.length).toBeGreaterThan(0);
  });

  it('is USELESS when taken after, which is why it is a separate step', () => {
    // Renewing rotates the token, so by the time the renewal has happened there
    // is no shared value left to match on and the sibling is silently left
    // holding a dead login. This is the mistake the snapshot exists to prevent.
    const { renewed, sibling } = sharedPair();
    renew(renewed.dir);
    const tooLate = snapshotSharing(renewed, [renewed, sibling], ['maxed']);

    expect(propagateRenewal(renewed.dir, tooLate.sharedWith, tooLate.fingerprint)).toEqual([]);
    expect(refreshTokenOf(sibling.dir)).toBe('refresh-shared'); // still the dead one
  });
});
