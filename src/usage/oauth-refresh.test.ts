import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { refreshCredentialIfExpired } from './oauth-refresh.js';
import { forgetRefusals } from './dead-login-memo.js';
import { credentialPath, previousCredentialPath } from '../accounts/credential-vault.js';

const HOUR = 3600_000;

function account(oauth: Record<string, unknown> | null, extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-refresh-'));
  writeFileSync(
    credentialPath(dir),
    JSON.stringify({ ...(oauth ? { claudeAiOauth: oauth } : {}), ...extra }),
    'utf8',
  );
  return dir;
}

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

const now = () => 1_000_000_000_000;

describe('a login the endpoint has already refused', () => {
  beforeEach(() => forgetRefusals());

  it('is NOT asked a second time', async () => {
    // invalid_grant is final for that refresh token, so a second request cannot
    // get a different answer. In the log that motivated this, one dead login
    // was re-asked 472 times.
    const dir = account({ accessToken: 'old', refreshToken: 'r-dead', expiresAt: now() - HOUR });
    let calls = 0;
    const counting: typeof fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const first = await refreshCredentialIfExpired(dir, { now, fetchImpl: counting });
    expect(first.status).toBe('needs-login');
    expect(first.alreadyKnown).toBeUndefined();

    const second = await refreshCredentialIfExpired(dir, { now, fetchImpl: counting });
    expect(second.status).toBe('needs-login');
    // Flagged so the caller reports it once instead of on every check.
    expect(second.alreadyKnown).toBe(true);
    expect(second.detail).toContain('invalid_grant');
    expect(calls).toBe(1);
  });

  it('IS asked again once the credential changes, which is what signing in does', async () => {
    const dir = account({ accessToken: 'old', refreshToken: 'r-dead', expiresAt: now() - HOUR });
    let calls = 0;
    const dead: typeof fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    }) as unknown as typeof fetch;
    expect((await refreshCredentialIfExpired(dir, { now, fetchImpl: dead })).status).toBe('needs-login');

    // Signing in rewrites the file, so the refusal must not follow the account.
    writeFileSync(
      credentialPath(dir),
      JSON.stringify({ claudeAiOauth: { accessToken: 'old', refreshToken: 'r-fresh', expiresAt: now() - HOUR } }),
      'utf8',
    );
    const after = await refreshCredentialIfExpired(dir, {
      now,
      fetchImpl: jsonFetch(200, { access_token: 'new-access', refresh_token: 'r-newer', expires_in: 28800 }),
    });
    expect(after.status).toBe('refreshed');
    expect(calls).toBe(1);
  });

  it('IS asked again when the file changes but the token does not', async () => {
    // The memo is keyed on the whole credential, not just the token. Hashing
    // only the token would be more precise, but a credential repaired in a way
    // that leaves the token in place would then stay refused until the process
    // restarted, and being stuck costs more than a repeated request.
    const dir = account({ accessToken: 'old', refreshToken: 'r-same', expiresAt: now() - HOUR });
    let calls = 0;
    const dead: typeof fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    }) as unknown as typeof fetch;

    expect((await refreshCredentialIfExpired(dir, { now, fetchImpl: dead })).status).toBe('needs-login');
    expect(calls).toBe(1);

    // Same refreshToken, different file contents.
    writeFileSync(
      credentialPath(dir),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'repaired', refreshToken: 'r-same', expiresAt: now() - HOUR },
      }),
      'utf8',
    );
    expect((await refreshCredentialIfExpired(dir, { now, fetchImpl: dead })).status).toBe('needs-login');
    expect(calls).toBe(2);
  });

  it('does NOT remember a transient failure, so a blip stays retryable', async () => {
    const dir = account({ accessToken: 'old', refreshToken: 'r-blip', expiresAt: now() - HOUR });
    let calls = 0;
    const flaky: typeof fetch = (async () => {
      calls += 1;
      return new Response('upstream down', { status: 503 });
    }) as unknown as typeof fetch;
    expect((await refreshCredentialIfExpired(dir, { now, fetchImpl: flaky })).status).toBe('unavailable');
    expect((await refreshCredentialIfExpired(dir, { now, fetchImpl: flaky })).status).toBe('unavailable');
    expect(calls).toBe(2);
  });
});

describe('refreshCredentialIfExpired', () => {
  it('renews an expired token and writes the new one immediately', async () => {
    const dir = account({ accessToken: 'old', refreshToken: 'r-old', expiresAt: now() - HOUR });
    const outcome = await refreshCredentialIfExpired(dir, {
      now,
      fetchImpl: jsonFetch(200, { access_token: 'new-access', refresh_token: 'r-new', expires_in: 28800 }),
    });
    expect(outcome.status).toBe('refreshed');

    const saved = JSON.parse(readFileSync(credentialPath(dir), 'utf8')).claudeAiOauth;
    expect(saved.accessToken).toBe('new-access');
    expect(saved.refreshToken).toBe('r-new'); // the rotated token is persisted
    expect(saved.expiresAt).toBe(now() + 28800 * 1000);
    // The previous generation is kept in case the new one turns out bad.
    expect(existsSync(previousCredentialPath(dir))).toBe(true);
  });

  it('preserves unrelated credential content (e.g. other stored logins)', async () => {
    const dir = account(
      { accessToken: 'old', refreshToken: 'r-old', expiresAt: now() - HOUR },
      { mcpOAuth: { some_server: { accessToken: 'keep-me' } } },
    );
    await refreshCredentialIfExpired(dir, {
      now,
      fetchImpl: jsonFetch(200, { access_token: 'new-access' }),
    });
    const saved = JSON.parse(readFileSync(credentialPath(dir), 'utf8'));
    expect(saved.mcpOAuth.some_server.accessToken).toBe('keep-me');
  });

  it('does nothing when the token is still good', async () => {
    const dir = account({ accessToken: 'live', refreshToken: 'r', expiresAt: now() + 8 * HOUR });
    const called: string[] = [];
    const outcome = await refreshCredentialIfExpired(dir, {
      now,
      fetchImpl: (async () => {
        called.push('fetch');
        return new Response('{}');
      }) as unknown as typeof fetch,
    });
    expect(outcome.status).toBe('not-needed');
    expect(called).toEqual([]); // never touches the network needlessly
  });

  it('renews slightly BEFORE expiry so a session never starts on a dying token', async () => {
    const dir = account({ accessToken: 'live', refreshToken: 'r', expiresAt: now() + 60_000 });
    const outcome = await refreshCredentialIfExpired(dir, {
      now,
      fetchImpl: jsonFetch(200, { access_token: 'fresh' }),
    });
    expect(outcome.status).toBe('refreshed');
  });

  it('reports needs-login on a dead grant, without touching the stored credential', async () => {
    const dir = account({ accessToken: 'old', refreshToken: 'r-dead', expiresAt: now() - HOUR });
    const before = readFileSync(credentialPath(dir), 'utf8');
    const outcome = await refreshCredentialIfExpired(dir, {
      now,
      fetchImpl: jsonFetch(400, { error: 'invalid_grant' }),
    });
    expect(outcome.status).toBe('needs-login');
    expect(readFileSync(credentialPath(dir), 'utf8')).toBe(before);
  });

  it('treats a server error or network failure as temporary, never needs-login', async () => {
    const dir = account({ accessToken: 'old', refreshToken: 'r', expiresAt: now() - HOUR });
    expect(
      (await refreshCredentialIfExpired(dir, { now, fetchImpl: jsonFetch(503, 'upstream down') })).status,
    ).toBe('unavailable');

    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect((await refreshCredentialIfExpired(dir, { now, fetchImpl: boom })).status).toBe('unavailable');
  });

  it('reports needs-login when there is no refresh token, and unavailable for a non-oauth file', async () => {
    const noRefresh = account({ accessToken: '', refreshToken: '', expiresAt: 0 });
    expect((await refreshCredentialIfExpired(noRefresh, { now })).status).toBe('needs-login');

    const notOauth = account(null, { primaryApiKey: 'sk-ant-x' });
    expect((await refreshCredentialIfExpired(notOauth, { now })).status).toBe('unavailable');
  });
});
