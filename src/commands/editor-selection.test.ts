import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { signedInAndNotRejected } from './editor-launch.js';
import { rememberDeadLogin } from '../usage/dead-login-store.js';
import { credentialFileFingerprint } from '../accounts/credential-vault.js';
import type { Account } from '../accounts/registry.schema.js';

/**
 * A config home of its own per test, so nothing here can see or touch real
 * state, and an account whose credential file is real enough to fingerprint.
 */
function setup(names: string[]) {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-editor-sel-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  const accounts: Account[] = names.map((name, i) => {
    const dir = path.join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: `tok-${name}`, refreshToken: 'r' } }),
      'utf8',
    );
    return { name, dir, priority: i, enabled: true } as Account;
  });
  return { ctx, accounts };
}

const signedIn = (names: string[]) => names.map((name) => ({ name, loggedIn: true }));

describe('which probed accounts count as somewhere to launch', () => {
  it('keeps the accounts the probe says are signed in', () => {
    const { ctx, accounts } = setup(['a', 'b']);
    expect([...signedInAndNotRejected(signedIn(['a', 'b']), accounts, ctx)]).toEqual(['a', 'b']);
  });

  it('drops one the token endpoint has rejected, even though the probe says signed in', () => {
    // The gap this closes. The probe asks Claude whether the profile LOOKS
    // signed in and it answers yes, because the file is intact. Only ccx knows
    // the refresh token was refused afterwards.
    const { ctx, accounts } = setup(['dead', 'good']);
    rememberDeadLogin(
      credentialFileFingerprint(accounts[0]!.dir),
      'token endpoint 400: invalid_grant',
      ctx,
    );
    expect([...signedInAndNotRejected(signedIn(['dead', 'good']), accounts, ctx)]).toEqual(['good']);
  });

  it('does not add an account the probe says is signed OUT', () => {
    const { ctx, accounts } = setup(['a', 'b']);
    const healths = [
      { name: 'a', loggedIn: false },
      { name: 'b', loggedIn: true },
    ];
    expect([...signedInAndNotRejected(healths, accounts, ctx)]).toEqual(['b']);
  });

  it('ignores a probed name that is not a registered account', () => {
    const { ctx, accounts } = setup(['a']);
    expect([...signedInAndNotRejected(signedIn(['a', 'ghost']), accounts, ctx)]).toEqual(['a']);
  });

  it('trusts the probe over ccx own file check, for a login it does not recognise', () => {
    // A macOS account keeps its credential in the Keychain, so the profile has
    // no usable credential FILE. The probe still reports it signed in, and it is
    // right. An earlier version filtered this set through the file check too and
    // dropped exactly these accounts.
    const { ctx, accounts } = setup(['keychain']);
    writeFileSync(path.join(accounts[0]!.dir, '.credentials.json'), '{}', 'utf8');
    expect([...signedInAndNotRejected(signedIn(['keychain']), accounts, ctx)]).toEqual(['keychain']);
  });
});
