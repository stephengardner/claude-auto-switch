import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { lendBundleFor, renewAhead, targetAccounts, targetSettings } from './owner.js';
import { LENT_HINT_FILE, LENT_MARKER } from './lent-login.js';
import { listAccounts, getAccount, updateAccount } from '../accounts/registry.js';
import { credentialFileFingerprint } from '../accounts/credential-vault.js';
import { rememberDeadLogin } from '../usage/dead-login-store.js';
import { forgetRefusals } from '../usage/dead-login-memo.js';
import { releaseLease, takeLease } from '../session/lease.js';
import { CREDENTIALS_LOCK_DIR } from '../claude/locks.js';
import { LendingSchema } from '../config/config.schema.js';
import { HOUR, MINUTE, machine, ownLogin, type Machine } from '../../test/lending-fixtures.js';

const NOW = 1_800_000_000_000;

/** The token endpoint, counting what it is sent and renewing every login it is asked about. */
function tokenEndpoint(): { fetchImpl: typeof fetch; sent: Array<Record<string, string>> } {
  const sent: Array<Record<string, string>> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    sent.push(body);
    const refresh = body.refresh_token ?? '';
    return new Response(
      JSON.stringify({
        access_token: `${refresh.replace(/^rt-/, 'at-')}-renewed`,
        refresh_token: `${refresh}-next`,
        expires_in: 8 * 3600,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

function stored(dir: string): { accessToken: string; refreshToken: string; expiresAt: number } {
  return (
    JSON.parse(readFileSync(path.join(dir, '.credentials.json'), 'utf8')) as {
      claudeAiOauth: { accessToken: string; refreshToken: string; expiresAt: number };
    }
  ).claudeAiOauth;
}

function account(m: Machine, name = 'work') {
  const found = getAccount(name, m.ctx);
  if (!found) throw new Error(`no account ${name}`);
  return found;
}

describe('what the owner lends', () => {
  it('is the access token and who the account is, never the refresh token', () => {
    const m = machine();
    ownLogin(m, 'work', { expiresAt: NOW + 6 * HOUR });
    const bundle = lendBundleFor(account(m), m.ctx, NOW);
    expect(bundle.claudeAiOauth).toMatchObject({
      accessToken: 'at-work-1',
      expiresAt: NOW + 6 * HOUR,
      subscriptionType: 'max',
    });
    expect(bundle.oauthAccount).toEqual({
      emailAddress: 'work@example.com',
      accountUuid: 'uuid-work',
    });
    expect(JSON.stringify(bundle)).not.toContain('rt-work-1');
    // The install id is this machine's, not the account's.
    expect(JSON.stringify(bundle)).not.toContain('install-work');
  });

  it('is refused for an account this machine cannot lend, saying why', () => {
    const m = machine();
    const lentDir = ownLogin(m, 'borrowed', { expiresAt: NOW + HOUR });
    writeFileSync(
      path.join(lentDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'at', expiresAt: NOW + HOUR },
        [LENT_MARKER]: { version: 1 },
      }),
    );
    writeFileSync(path.join(lentDir, LENT_HINT_FILE), '{}');
    expect(() => lendBundleFor(account(m, 'borrowed'), m.ctx, NOW)).toThrow(
      /is lent to this machine/,
    );

    ownLogin(m, 'stale', { expiresAt: NOW - MINUTE });
    expect(() => lendBundleFor(account(m, 'stale'), m.ctx, NOW)).toThrow(
      /has expired; renew it first \(ccx renew stale\)/,
    );

    const refusedDir = ownLogin(m, 'refused', { expiresAt: NOW + HOUR });
    rememberDeadLogin(credentialFileFingerprint(refusedDir), 'invalid_grant', m.ctx);
    expect(() => lendBundleFor(account(m, 'refused'), m.ctx, NOW)).toThrow(
      /signed out at Anthropic/,
    );

    const outDir = ownLogin(m, 'out', { expiresAt: NOW + HOUR });
    writeFileSync(
      path.join(outDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 } }),
    );
    expect(() => lendBundleFor(account(m, 'out'), m.ctx, NOW)).toThrow(/is not signed in here/);
  });
});

describe('renewing ahead on the owner', () => {
  beforeEach(() => forgetRefusals());

  it('sends nothing while more than the ahead time is left', async () => {
    const m = machine();
    ownLogin(m, 'work', { expiresAt: NOW + 3 * HOUR });
    const endpoint = tokenEndpoint();
    const result = await renewAhead(account(m), listAccounts(m.ctx), m.ctx, {
      aheadMs: 90 * MINUTE,
      now: () => NOW,
      refresh: { fetchImpl: endpoint.fetchImpl },
    });
    expect(result).toEqual({ outcome: 'fresh', expiresAt: NOW + 3 * HOUR });
    expect(endpoint.sent).toEqual([]);
  });

  it('renews once inside the ahead time, through the renewal every other part of ccx uses', async () => {
    const m = machine();
    const dir = ownLogin(m, 'work', { expiresAt: NOW + HOUR });
    const endpoint = tokenEndpoint();
    const result = await renewAhead(account(m), listAccounts(m.ctx), m.ctx, {
      aheadMs: 90 * MINUTE,
      now: () => NOW,
      refresh: { fetchImpl: endpoint.fetchImpl },
    });
    expect(result).toEqual({ outcome: 'renewed', expiresAt: NOW + 8 * HOUR });
    expect(endpoint.sent).toEqual([
      expect.objectContaining({ grant_type: 'refresh_token', refresh_token: 'rt-work-1' }),
    ]);
    expect(stored(dir)).toMatchObject({
      accessToken: 'at-work-1-renewed',
      refreshToken: 'rt-work-1-next',
    });
    // The ordinary renewal's cushion: the previous generation is kept.
    expect(existsSync(path.join(dir, '.credentials.prev.json'))).toBe(true);
  });

  it('renews whatever is left when forced', async () => {
    const m = machine();
    ownLogin(m, 'work', { expiresAt: NOW + 7 * HOUR });
    const endpoint = tokenEndpoint();
    const result = await renewAhead(account(m), listAccounts(m.ctx), m.ctx, {
      aheadMs: 90 * MINUTE,
      force: true,
      now: () => NOW,
      refresh: { fetchImpl: endpoint.fetchImpl },
    });
    expect(result.outcome).toBe('renewed');
    expect(endpoint.sent).toHaveLength(1);
  });

  it('sends nothing while something else holds the login lock, the one a renewal by Claude takes', async () => {
    const m = machine();
    const dir = ownLogin(m, 'work', { expiresAt: NOW + HOUR });
    mkdirSync(path.join(dir, CREDENTIALS_LOCK_DIR));
    const endpoint = tokenEndpoint();
    const result = await renewAhead(account(m), listAccounts(m.ctx), m.ctx, {
      aheadMs: 90 * MINUTE,
      now: () => NOW,
      refresh: { fetchImpl: endpoint.fetchImpl },
    });
    expect(result.outcome).toBe('busy');
    expect(endpoint.sent).toEqual([]);
  });

  it('never renews a login a running session holds, since that would sign the session out', async () => {
    const m = machine();
    ownLogin(m, 'work', { expiresAt: NOW + HOUR });
    takeLease('work', path.join(m.home, 'sessions', 'one'), m.ctx);
    const endpoint = tokenEndpoint();
    try {
      const result = await renewAhead(account(m), listAccounts(m.ctx), m.ctx, {
        aheadMs: 90 * MINUTE,
        force: true,
        now: () => NOW,
        refresh: { fetchImpl: endpoint.fetchImpl },
      });
      expect(result.outcome).toBe('in-use');
      expect(result.detail).toMatch(/a session is using work/);
      expect(endpoint.sent).toEqual([]);
    } finally {
      releaseLease('work', m.ctx);
    }
  });

  it('refuses a lent login, which only its owner renews', async () => {
    const m = machine();
    const dir = ownLogin(m, 'work', { expiresAt: NOW - HOUR });
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'at', expiresAt: NOW - HOUR },
        [LENT_MARKER]: { version: 1 },
      }),
    );
    writeFileSync(path.join(dir, LENT_HINT_FILE), '{}');
    const endpoint = tokenEndpoint();
    await expect(
      renewAhead(account(m), listAccounts(m.ctx), m.ctx, {
        aheadMs: HOUR,
        force: true,
        refresh: { fetchImpl: endpoint.fetchImpl },
      }),
    ).rejects.toThrow(/the machine that lends it renews it/);
    expect(endpoint.sent).toEqual([]);
  });
});

describe('which accounts a target lends', () => {
  it('lends a list as given, all of the enabled ones, or all but the active one', () => {
    const m = machine();
    ownLogin(m, 'a', { expiresAt: NOW + HOUR });
    ownLogin(m, 'b', { expiresAt: NOW + HOUR });
    ownLogin(m, 'c', { expiresAt: NOW + HOUR });
    updateAccount('c', { enabled: false }, m.ctx);
    const accounts = listAccounts(m.ctx);
    const target = (accounts: unknown) =>
      ({ name: 't', transport: { type: 'directory' as const, path: '/x' }, accounts }) as never;
    expect(targetAccounts(target(['c', 'zzz']), accounts, 'a')).toEqual({
      names: ['c', 'zzz'],
      explicit: true,
    });
    expect(targetAccounts(target('all'), accounts, 'a')).toEqual({
      names: ['a', 'b'],
      explicit: false,
    });
    expect(targetAccounts(target('all-except-active'), accounts, 'a')).toEqual({
      names: ['b'],
      explicit: false,
    });
  });

  it("takes a target's own settings over the section's", () => {
    const lending = LendingSchema.parse({
      renewAheadMinutes: 90,
      expiryMarginMinutes: 10,
      targets: [
        {
          name: 'own',
          transport: { type: 'directory', path: '/x' },
          accounts: 'all',
          renewAheadMinutes: 120,
          expiryMarginMinutes: 20,
        },
        { name: 'shared', transport: { type: 'directory', path: '/y' }, accounts: 'all' },
      ],
    });
    expect(targetSettings(lending.targets[0]!, lending)).toEqual({
      aheadMs: 120 * MINUTE,
      marginMs: 20 * MINUTE,
    });
    expect(targetSettings(lending.targets[1]!, lending)).toEqual({
      aheadMs: 90 * MINUTE,
      marginMs: 10 * MINUTE,
    });
  });
});
