import { describe, it, expect, beforeEach } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { refreshCredentialIfExpired, renewalIsDue } from './oauth-refresh.js';
import { CREDENTIALS_LOCK_DIR } from '../claude/locks.js';
import { forgetRefusals } from './dead-login-memo.js';
import { credentialFileFingerprint, credentialPath, previousCredentialPath } from '../accounts/credential-vault.js';
import { deadLoginReason } from './dead-login-store.js';
import { sha256Fingerprint } from '../util/fingerprint.js';

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

  it('does not ask again in a LATER process, which is why the note is on disk', async () => {
    // Clearing only the in-process memory is exactly what a new process looks
    // like: nothing tried yet. Without the note, every fresh session spends a
    // request rediscovering a refusal that is already recorded.
    const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: mkdtempSync(path.join(tmpdir(), 'cas-cross-')) } };
    const dir = account({ accessToken: 'old', refreshToken: 'r-dead', expiresAt: now() - HOUR });
    let calls = 0;
    const counting: typeof fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    }) as unknown as typeof fetch;

    expect((await refreshCredentialIfExpired(dir, { now, fetchImpl: counting, ctx })).status).toBe(
      'needs-login',
    );
    expect(calls).toBe(1);

    forgetRefusals();
    const later = await refreshCredentialIfExpired(dir, { now, fetchImpl: counting, ctx });
    expect(later.status).toBe('needs-login');
    expect(later.alreadyKnown).toBe(true);
    expect(later.detail).toContain('invalid_grant');
    expect(calls).toBe(1);
  });

  it('writes NOTHING when no state location is given', async () => {
    // Nothing here defaults to the real config home. An earlier draft did, and
    // the first test that forgot to pass one wrote into live state.
    const dir = account({ accessToken: 'old', refreshToken: 'r-dead2', expiresAt: now() - HOUR });
    forgetRefusals();
    const outcome = await refreshCredentialIfExpired(dir, {
      now,
      fetchImpl: jsonFetch(400, { error: 'invalid_grant' }),
    });
    expect(outcome.status).toBe('needs-login');
    // No ctx, so no note anywhere: the only record is the in-process one.
    forgetRefusals();
    let calls = 0;
    const counting: typeof fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    }) as unknown as typeof fetch;
    await refreshCredentialIfExpired(dir, { now, fetchImpl: counting });
    expect(calls).toBe(1);
  });

  it('remembers ONLY an invalid_grant, not a 401 or a malformed request', async () => {
    // Reporting and remembering are different questions. All of these still say
    // needs-login, so a real rejection is never mistaken for a network blip. But
    // only invalid_grant means the server rejected THIS refresh token, and a
    // note outlasts the moment: it survives the process and makes the status
    // line say "needs sign-in" until the credential changes. A bare 401 or a
    // malformed request would bench a working account for no reason.
    const cases = [
      { body: { error: 'invalid_request' }, status: 400, remembered: false },
      { body: { error: 'unauthorized' }, status: 401, remembered: false },
      { body: {}, status: 401, remembered: false },
      { body: { error: 'invalid_grant' }, status: 400, remembered: true },
    ];
    for (const testCase of cases) {
      const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: mkdtempSync(path.join(tmpdir(), 'cas-cls-')) } };
      const dir = account({ accessToken: 'a', refreshToken: `r-${testCase.status}-${JSON.stringify(testCase.body)}`, expiresAt: now() - HOUR });
      forgetRefusals();
      const outcome = await refreshCredentialIfExpired(dir, {
        now,
        ctx,
        fetchImpl: jsonFetch(testCase.status, testCase.body),
      });
      expect(outcome.status, JSON.stringify(testCase)).toBe('needs-login');
      // The durable half is the one that must be strict.
      expect(existsSync(path.join(ctx.env.CLAUDE_AUTO_SWITCH_HOME, 'dead-logins.json')), JSON.stringify(testCase))
        .toBe(testCase.remembered);
    }
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

/**
 * A refresh token works once. Whatever else is renewing the same login, in
 * this process or another, a renewal must never send a token that has
 * already been spent.
 */
describe('renewing a login something else may be renewing', () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  function counting(): { fetchImpl: typeof fetch; calls: () => number } {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      await sleep(50);
      return new Response(JSON.stringify({ access_token: 'a-renewed', refresh_token: 'r-renewed', expires_in: 28800 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls: () => calls };
  }

  it('never renews without the lock: one held by another process past the wait is reported busy', async () => {
    const dir = account({ accessToken: 'old', refreshToken: 'r-held', expiresAt: now() - HOUR });
    // Another process holds Claude's lock on this login, and keeps it.
    mkdirSync(path.join(dir, CREDENTIALS_LOCK_DIR));
    const endpoint = counting();
    const outcome = await refreshCredentialIfExpired(dir, { now, fetchImpl: endpoint.fetchImpl, lockWaitMs: 200 });
    expect(endpoint.calls()).toBe(0);
    expect(outcome.status).toBe('busy');
    expect(JSON.parse(readFileSync(credentialPath(dir), 'utf8')).claudeAiOauth.refreshToken).toBe('r-held');
  });

  it('waits for the lock with the thread free, and renews once it is let go', async () => {
    // A running session renews on the thread that relays Claude's terminal.
    const dir = account({ accessToken: 'old', refreshToken: 'r-wait', expiresAt: now() - HOUR });
    const lock = path.join(dir, CREDENTIALS_LOCK_DIR);
    mkdirSync(lock);
    setTimeout(() => rmSync(lock, { recursive: true, force: true }), 400);
    let ticks = 0;
    const tick = setInterval(() => (ticks += 1), 20);
    const endpoint = counting();
    let status: string;
    try {
      status = (await refreshCredentialIfExpired(dir, { now, fetchImpl: endpoint.fetchImpl, lockWaitMs: 5_000 })).status;
    } finally {
      clearInterval(tick);
    }
    expect(status).toBe('refreshed');
    expect(endpoint.calls()).toBe(1);
    expect(ticks).toBeGreaterThan(5);
    expect(existsSync(lock)).toBe(false);
  });

  it('reads the login again once it holds the lock, so a renewal made meanwhile is not repeated', async () => {
    const dir = account({ accessToken: 'old', refreshToken: 'r-raced', expiresAt: now() - HOUR });
    const ready = path.join(dir, 'other-process-ready');
    // Another process: takes the lock, renews the login, then lets the lock go.
    const other = spawn(
      process.execPath,
      [
        '-e',
        [
          "const fs = require('node:fs');",
          'const [lock, file, ready, expiresAt] = process.argv.slice(1);',
          'fs.mkdirSync(lock);',
          "fs.writeFileSync(ready, '');",
          'setTimeout(() => {',
          "  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'a-other', refreshToken: 'r-other', expiresAt: Number(expiresAt) } }));",
          '  fs.rmdirSync(lock);',
          '}, 800);',
        ].join('\n'),
        path.join(dir, CREDENTIALS_LOCK_DIR),
        credentialPath(dir),
        ready,
        String(now() + 8 * HOUR),
      ],
      { stdio: 'ignore' },
    );
    const exited = new Promise((resolve) => other.on('exit', resolve));
    for (let waited = 0; !existsSync(ready) && waited < 10_000; waited += 20) await sleep(20);
    expect(existsSync(ready)).toBe(true);

    const endpoint = counting();
    const outcome = await refreshCredentialIfExpired(dir, { now, fetchImpl: endpoint.fetchImpl, lockWaitMs: 5_000 });
    await exited;
    expect(endpoint.calls()).toBe(0);
    expect(outcome.status).toBe('not-needed');
    expect(JSON.parse(readFileSync(credentialPath(dir), 'utf8')).claudeAiOauth.refreshToken).toBe('r-other');
  });

  it('renews a login once when two profiles hold it and both are renewed at the same time', async () => {
    const first = account({ accessToken: 'old', refreshToken: 'r-shared', expiresAt: now() - HOUR });
    const second = account({ accessToken: 'old', refreshToken: 'r-shared', expiresAt: now() - HOUR });
    const endpoint = counting();
    await Promise.all([
      refreshCredentialIfExpired(first, { now, fetchImpl: endpoint.fetchImpl }),
      refreshCredentialIfExpired(second, { now, fetchImpl: endpoint.fetchImpl }),
    ]);
    expect(endpoint.calls()).toBe(1);
  });

  // Folder permissions are what make the lock impossible here; Windows has none of these.
  it.skipIf(process.platform === 'win32')(
    'reports a lock it cannot create as a failure, not as something else renewing',
    async () => {
      // A profile folder it cannot write into, as one `sudo ccx` made leaves.
      const dir = account({ accessToken: 'old', refreshToken: 'r-locked-out', expiresAt: now() - HOUR });
      chmodSync(dir, 0o500);
      try {
        const endpoint = counting();
        const outcome = await refreshCredentialIfExpired(dir, { now, fetchImpl: endpoint.fetchImpl, lockWaitMs: 0 });
        expect(endpoint.calls()).toBe(0);
        expect(outcome.status).toBe('unavailable');
        expect(outcome.detail).toContain('lock');
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  it('gives up on a token request that does not answer, and lets the lock go', async () => {
    const dir = account({ accessToken: 'old', refreshToken: 'r-slow', expiresAt: now() - HOUR });
    const silent = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const outcome = await Promise.race([
      refreshCredentialIfExpired(dir, { now, fetchImpl: silent, requestTimeoutMs: 100 }),
      sleep(3_000).then(() => 'still waiting' as const),
    ]);
    expect(outcome).toMatchObject({ status: 'unavailable' });
    expect(existsSync(path.join(dir, CREDENTIALS_LOCK_DIR))).toBe(false);
  });
});

describe('renewing a login the server has just turned away', () => {
  beforeEach(() => forgetRefusals());

  it('renews before the stored expiry, when the token it holds is the one turned away', async () => {
    const dir = account({ accessToken: 'revoked', refreshToken: 'r', expiresAt: now() + 8 * HOUR });
    const outcome = await refreshCredentialIfExpired(dir, {
      now,
      renewRejected: sha256Fingerprint('revoked'),
      fetchImpl: jsonFetch(200, { access_token: 'fresh', refresh_token: 'r2', expires_in: 28800 }),
    });
    expect(outcome.status).toBe('refreshed');
    expect(JSON.parse(readFileSync(credentialPath(dir), 'utf8')).claudeAiOauth.accessToken).toBe('fresh');
  });

  it('sends nothing when the login has changed since, so a renewal made meanwhile is not repeated', async () => {
    const dir = account({ accessToken: 'renewed-meanwhile', refreshToken: 'r', expiresAt: now() + 8 * HOUR });
    let calls = 0;
    const outcome = await refreshCredentialIfExpired(dir, {
      now,
      renewRejected: sha256Fingerprint('revoked'),
      fetchImpl: (async () => {
        calls += 1;
        return new Response('{}');
      }) as unknown as typeof fetch,
    });
    expect(outcome.status).toBe('not-needed');
    expect(calls).toBe(0);
  });

  it('writes down why, word for word, when the account is on hold', async () => {
    // The token endpoint's answer for an account Anthropic had restricted.
    const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: mkdtempSync(path.join(tmpdir(), 'cas-hold-')) } };
    const dir = account({ accessToken: 'revoked', refreshToken: 'r', expiresAt: now() + 8 * HOUR });
    const outcome = await refreshCredentialIfExpired(dir, {
      now,
      ctx,
      renewRejected: sha256Fingerprint('revoked'),
      fetchImpl: jsonFetch(400, {
        error: 'invalid_grant',
        error_description: 'account_on_hold',
        error_uri: 'https://claude.ai/restricted',
      }),
    });
    expect(outcome.status).toBe('needs-login');
    expect(deadLoginReason(credentialFileFingerprint(dir), ctx)).toContain('account_on_hold');
  });
});

describe('a login lent to this machine', () => {
  beforeEach(() => forgetRefusals());

  /** A lend as `ccx lend import` installs it: an access token, the marker, no refresh token. */
  function lent(expiresAt: number): string {
    return account({ accessToken: 'at-lent', expiresAt }, { ccxLend: { version: 1, issuedAt: 0 } });
  }

  it('is never renewed here, however it is asked: nothing is sent and the file is left as it was', async () => {
    const dir = lent(now() - HOUR);
    const before = readFileSync(credentialPath(dir), 'utf8');
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ access_token: 'x', refresh_token: 'y', expires_in: 60 }));
    }) as unknown as typeof fetch;
    // Expired, renew-whatever-is-left (ccx renew --force), and turned away by the API.
    for (const asked of [{}, { renewWithinMs: Number.POSITIVE_INFINITY }, { renewRejected: sha256Fingerprint('at-lent') }]) {
      const outcome = await refreshCredentialIfExpired(dir, { now, fetchImpl: counting, ...asked });
      // Its own answer, never needs-login: the lend has not been signed out, it waits for its owner.
      expect(outcome.status).toBe('lent');
    }
    expect(calls).toBe(0);
    expect(readFileSync(credentialPath(dir), 'utf8')).toBe(before);
  });

  it('is never due for renewal, so nothing renews it before a move either', () => {
    expect(renewalIsDue(lent(now() - HOUR), now)).toBe(false);
  });

  it("is this machine's own login once a sign-in here has given it a refresh token", async () => {
    const dir = account(
      { accessToken: 'at-own', refreshToken: 'rt-own', expiresAt: now() - HOUR },
      { ccxLend: { version: 1, issuedAt: 0 } },
    );
    const outcome = await refreshCredentialIfExpired(dir, {
      now,
      fetchImpl: jsonFetch(200, { access_token: 'at-own-2', refresh_token: 'rt-own-2', expires_in: 3600 }),
    });
    expect(outcome.status).toBe('refreshed');
  });
});

describe('renewing further ahead than usual', () => {
  beforeEach(() => forgetRefusals());

  it('renews a login with an hour left only when asked to renew that far ahead', async () => {
    const dir = account({ accessToken: 'a', refreshToken: 'r', expiresAt: now() + HOUR });
    const endpoint = jsonFetch(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 8 * 3600 });
    expect((await refreshCredentialIfExpired(dir, { now, fetchImpl: endpoint })).status).toBe('not-needed');
    expect((await refreshCredentialIfExpired(dir, { now, fetchImpl: endpoint, renewWithinMs: 90 * 60_000 })).status).toBe(
      'refreshed',
    );
    const renewed = JSON.parse(readFileSync(credentialPath(dir), 'utf8')) as { claudeAiOauth: Record<string, unknown> };
    expect(renewed.claudeAiOauth).toMatchObject({ accessToken: 'a2', refreshToken: 'r2', expiresAt: now() + 8 * HOUR });
    // Read again under the lock: what was just renewed has hours left, so asking again sends nothing.
    expect((await refreshCredentialIfExpired(dir, { now, fetchImpl: endpoint, renewWithinMs: 90 * 60_000 })).status).toBe(
      'not-needed',
    );
  });
});
