import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hasLogin } from './account-login.js';
import { saveToken } from '../daemon/token-store.js';

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
