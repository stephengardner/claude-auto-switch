import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hasLogin, hasWorkingLogin } from './account-login.js';
import { saveToken } from '../daemon/token-store.js';
import { rememberDeadLogin } from '../usage/dead-login-store.js';
import { refreshCredentialIfExpired } from '../usage/oauth-refresh.js';
import { credentialFileFingerprint } from './credential-vault.js';

function accountDir(): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'cas-login-')), 'profile');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeCredential(dir: string, oauth: Record<string, unknown>): void {
  writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }), 'utf8');
}

describe('whether an account has something to authenticate with', () => {
  it('says yes for a credentials file carrying an access token', () => {
    const dir = accountDir();
    writeCredential(dir, { accessToken: 'sk-ant-live', refreshToken: 'r' });
    expect(hasLogin(dir)).toBe(true);
  });

  it('says yes for a stored token with no credentials file', () => {
    // How macOS accounts look: the credential lives in the Keychain, so the only
    // thing on disk is the token ccx stored. Written through saveToken rather
    // than by hand so this cannot drift from the real format.
    const dir = accountDir();
    saveToken(dir, 'sk-ant-stored');
    expect(hasLogin(dir)).toBe(true);
  });

  it('says NO for a signed-out profile that still has a complete credential file', () => {
    // The case the whole predicate exists for. Claude leaves the file in place
    // with empty token strings, so "the file is there" would pick an account
    // that cannot start a session, and the failure then reads as a usage limit.
    const dir = accountDir();
    writeCredential(dir, { accessToken: '', refreshToken: '' });
    expect(hasLogin(dir)).toBe(false);
  });

  it('says no when there is neither a credential nor a token', () => {
    expect(hasLogin(accountDir())).toBe(false);
  });
});

describe('whether an account has a login that has NOT been rejected', () => {
  /** A config home of its own, so nothing here can see or touch real state. */
  function isolated(): { dir: string; ctx: { env: NodeJS.ProcessEnv } } {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-working-'));
    const dir = path.join(home, 'profiles', 'work');
    mkdirSync(dir, { recursive: true });
    writeCredential(dir, { accessToken: 'sk-ant-live', refreshToken: 'r' });
    return { dir, ctx: { env: { CLAUDE_AUTO_SWITCH_HOME: home } } };
  }

  it('says yes for a login nothing has rejected', () => {
    const { dir, ctx } = isolated();
    expect(hasWorkingLogin(dir, ctx)).toBe(true);
  });

  it('says NO once the token endpoint has rejected that exact credential', () => {
    // Recorded through the real store, so this cannot drift from the format the
    // renewal actually writes. Hand-writing that JSON produced a false pass once.
    const { dir, ctx } = isolated();
    rememberDeadLogin(credentialFileFingerprint(dir), 'token endpoint 400: invalid_grant', ctx);
    expect(hasWorkingLogin(dir, ctx)).toBe(false);
    // The narrow question is unchanged: there IS still something to authenticate
    // with, which is why the renewal path keeps asking that one.
    expect(hasLogin(dir)).toBe(true);
  });

  it('says yes again after signing in, with no note to clear', () => {
    // The refusal is keyed to the credential CONTENT, so a new login is a new
    // key and no stale note can hold down an account that works again.
    const { dir, ctx } = isolated();
    rememberDeadLogin(credentialFileFingerprint(dir), 'token endpoint 400: invalid_grant', ctx);
    expect(hasWorkingLogin(dir, ctx)).toBe(false);
    writeCredential(dir, { accessToken: 'sk-ant-fresh', refreshToken: 'r2' });
    expect(hasWorkingLogin(dir, ctx)).toBe(true);
  });

  it('says no when there is no login at all, rejected or not', () => {
    const { dir, ctx } = isolated();
    writeCredential(dir, { accessToken: '', refreshToken: '' });
    expect(hasWorkingLogin(dir, ctx)).toBe(false);
  });
});

describe('the record the REAL renewal writes, read back by hasWorkingLogin', () => {
  it('turns the account off after a genuine invalid_grant, and back on after signing in', async () => {
    // Deliberately does NOT seed the record with the same helper this reads
    // with: that arrangement agrees with itself even when the writer and the
    // reader disagree, which is how a mismatch shipped before. The refusal here
    // is produced by the renewal path itself, from a rejecting token endpoint.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-renewal-'));
    const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
    const dir = path.join(home, 'profiles', 'work');
    mkdirSync(dir, { recursive: true });
    // Expired, so a renewal is actually attempted.
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'old', refreshToken: 'finished', expiresAt: Date.now() - 60_000 },
      }),
      'utf8',
    );

    expect(hasWorkingLogin(dir, ctx)).toBe(true);

    const outcome = await refreshCredentialIfExpired(dir, {
      ctx,
      fetchImpl: () =>
        Promise.resolve(
          new Response('{"error":"invalid_grant"}', {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });
    expect(outcome.status).toBe('needs-login');

    // The reader agrees with what the renewal wrote. This is the assertion the
    // seeded version could never make.
    expect(hasWorkingLogin(dir, ctx)).toBe(false);

    // Signing in replaces the file, which changes the key, so nothing has to be
    // cleaned up for the account to work again.
    writeCredential(dir, { accessToken: 'sk-ant-fresh', refreshToken: 'new' });
    expect(hasWorkingLogin(dir, ctx)).toBe(true);
  });
});
