import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  installCredential,
  rollbackCredential,
  isUsableCredential,
  identityKey,
  credentialPath,
  previousCredentialPath,
  clearCredential,
} from './credential-vault.js';

function dir(): string {
  return mkdtempSync(path.join(tmpdir(), 'cas-vault-'));
}

function writeCred(file: string, account: string): void {
  writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: `tok-${account}` } }), 'utf8');
}

describe('isUsableCredential', () => {
  it('accepts a non-empty JSON object and rejects empty, garbage, or missing', () => {
    const d = dir();
    const good = path.join(d, 'good.json');
    writeCred(good, 'a');
    expect(isUsableCredential(good)).toBe(true);

    const empty = path.join(d, 'empty.json');
    writeFileSync(empty, '   ', 'utf8');
    expect(isUsableCredential(empty)).toBe(false);

    const partial = path.join(d, 'partial.json');
    writeFileSync(partial, '{"claudeAiOauth":', 'utf8'); // killed mid-write
    expect(isUsableCredential(partial)).toBe(false);

    const blank = path.join(d, 'blank.json');
    writeFileSync(blank, '{}', 'utf8');
    expect(isUsableCredential(blank)).toBe(false);

    expect(isUsableCredential(path.join(d, 'nope.json'))).toBe(false);
  });

  it('REJECTS a logged-out credential: right shape, empty tokens', () => {
    // Claude leaves exactly this behind when a session is logged out. Saving it
    // back over a stored account is what destroys a login.
    const d = dir();
    const loggedOut = path.join(d, 'out.json');
    writeFileSync(
      loggedOut,
      JSON.stringify({
        claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0, scopes: [], subscriptionType: 'max' },
      }),
      'utf8',
    );
    expect(isUsableCredential(loggedOut)).toBe(false);
  });

  it('accepts an API-key credential and an unfamiliar shape that carries content', () => {
    const d = dir();
    const apiKey = path.join(d, 'api.json');
    writeFileSync(apiKey, JSON.stringify({ primaryApiKey: 'sk-ant-abc123' }), 'utf8');
    expect(isUsableCredential(apiKey)).toBe(true);

    // Forward compatibility: a future format must not be refused wholesale.
    const future = path.join(d, 'future.json');
    writeFileSync(future, JSON.stringify({ somethingNew: { token: 'abc' } }), 'utf8');
    expect(isUsableCredential(future)).toBe(true);
  });
});

describe('installCredential (logged-out protection)', () => {
  it('refuses to overwrite a good login with a logged-out credential', () => {
    const d = dir();
    writeCred(credentialPath(d), 'good');
    const loggedOut = path.join(dir(), 'out.json');
    writeFileSync(loggedOut, JSON.stringify({ claudeAiOauth: { accessToken: '' } }), 'utf8');

    expect(installCredential(d, loggedOut)).toBe(false);
    expect(readFileSync(credentialPath(d), 'utf8')).toContain('tok-good');
  });
});

describe('installCredential', () => {
  it('installs and keeps the previous generation as a rollback cushion', () => {
    const d = dir();
    writeCred(credentialPath(d), 'old');
    const incoming = path.join(dir(), 'new.json');
    writeCred(incoming, 'new');

    expect(installCredential(d, incoming)).toBe(true);
    expect(readFileSync(credentialPath(d), 'utf8')).toContain('tok-new');
    expect(readFileSync(previousCredentialPath(d), 'utf8')).toContain('tok-old');
  });

  it('REFUSES to overwrite a good login with a corrupt credential', () => {
    const d = dir();
    writeCred(credentialPath(d), 'good');
    const corrupt = path.join(dir(), 'corrupt.json');
    writeFileSync(corrupt, '', 'utf8'); // a killed refresh left nothing

    expect(installCredential(d, corrupt)).toBe(false);
    expect(readFileSync(credentialPath(d), 'utf8')).toContain('tok-good'); // untouched
  });

  it('installs into a fresh dir with no previous generation', () => {
    const d = dir();
    const incoming = path.join(dir(), 'new.json');
    writeCred(incoming, 'first');
    expect(installCredential(d, incoming)).toBe(true);
    expect(existsSync(previousCredentialPath(d))).toBe(false);
  });
});

describe('rollbackCredential', () => {
  it('restores the previous generation after a bad swap', () => {
    const d = dir();
    writeCred(credentialPath(d), 'original');
    const incoming = path.join(dir(), 'new.json');
    writeCred(incoming, 'replacement');
    installCredential(d, incoming);
    expect(readFileSync(credentialPath(d), 'utf8')).toContain('tok-replacement');

    expect(rollbackCredential(d)).toBe(true);
    expect(readFileSync(credentialPath(d), 'utf8')).toContain('tok-original');
  });

  it('reports false when there is nothing to roll back to', () => {
    expect(rollbackCredential(dir())).toBe(false);
  });
});

describe('identityKey', () => {
  it('fingerprints the account identity and detects a different account', () => {
    const a = dir();
    const b = dir();
    writeFileSync(
      path.join(a, '.claude.json'),
      JSON.stringify({ oauthAccount: { accountUuid: 'u1', emailAddress: 'one@x.com' } }),
      'utf8',
    );
    writeFileSync(
      path.join(b, '.claude.json'),
      JSON.stringify({ oauthAccount: { accountUuid: 'u2', emailAddress: 'two@x.com' } }),
      'utf8',
    );
    expect(identityKey(a)).toBe('u1|one@x.com');
    expect(identityKey(a)).not.toBe(identityKey(b));
  });

  it('is null without an identity, and never throws on junk', () => {
    const d = dir();
    expect(identityKey(d)).toBeNull(); // no .claude.json
    writeFileSync(path.join(d, '.claude.json'), 'not json', 'utf8');
    expect(identityKey(d)).toBeNull();
  });
});

describe('clearCredential', () => {
  it('removes the live credential and tolerates it already being gone', () => {
    const d = dir();
    writeCred(credentialPath(d), 'x');
    clearCredential(d);
    expect(existsSync(credentialPath(d))).toBe(false);
    expect(() => clearCredential(d)).not.toThrow();
  });
});
