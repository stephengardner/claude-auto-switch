import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Each read of a login can start a `security` process on macOS, so a renewal
 * reads it only as often as it must: once to decide, and once more under the
 * lock, since whoever held the lock may have renewed it meanwhile.
 */
const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../accounts/credential-storage.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../accounts/credential-storage.js')>();
  return {
    ...real,
    // Every read of a login, blocking or on timers, is these steps.
    readCredentialSteps: function* (...args: Parameters<typeof real.readCredentialSteps>) {
      reads.count += 1;
      return yield* real.readCredentialSteps(...args);
    },
  };
});

const { refreshCredentialIfExpired } = await import('./oauth-refresh.js');
const { credentialPath } = await import('../accounts/credential-vault.js');

const now = () => 1_000_000_000_000;
const HOUR = 3600_000;

function account(oauth: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-refresh-reads-'));
  writeFileSync(credentialPath(dir), JSON.stringify({ claudeAiOauth: oauth }), 'utf8');
  return dir;
}

describe('how often a renewal reads the login', () => {
  it('reads a login with nothing to do once', async () => {
    const dir = account({ accessToken: 'a', refreshToken: 'r-fresh', expiresAt: now() + 8 * HOUR });
    reads.count = 0;
    expect((await refreshCredentialIfExpired(dir, { now })).status).toBe('not-needed');
    expect(reads.count).toBe(1);
  });

  it('reads a login it renews twice before asking: once to decide, once under the lock', async () => {
    const dir = account({ accessToken: 'a', refreshToken: 'r-due', expiresAt: now() - HOUR });
    let readsBeforeAsking = -1;
    const fetchImpl = (async () => {
      readsBeforeAsking = reads.count;
      return new Response(JSON.stringify({ access_token: 'a2', refresh_token: 'r2', expires_in: 28800 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    reads.count = 0;
    expect((await refreshCredentialIfExpired(dir, { now, fetchImpl })).status).toBe('refreshed');
    expect(readsBeforeAsking).toBe(2);
  });
});
