import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { refreshUsage, readUsageSnapshot } from './usage-store.js';
import type { LimitProbeResult } from './limit-probe.js';
import { readCredentialEvents } from '../accounts/credential-log.js';

function setup(names: string[]) {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-usage-'));
  const c = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  const accounts = names.map((name) => {
    const dir = path.join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    // A real-shaped login: an empty object is a signed-OUT profile, not a login.
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: `tok-${name}` } }),
      'utf8',
    );
    return { name, dir };
  });
  return { c, accounts };
}

const result = (fiveHour: number, sevenDay: number): LimitProbeResult => ({
  verdict: 'allowed',
  fiveHour,
  sevenDay,
  fiveHourReset: 1_000,
  sevenDayReset: 2_000,
});

describe('refreshUsage', () => {
  it('probes stale accounts, persists, and reads back', async () => {
    const { c, accounts } = setup(['a', 'b']);
    const probed: string[] = [];
    const snap = await refreshUsage(accounts, c, {
      probe: (file) => {
        probed.push(file);
        return Promise.resolve(result(0.25, 0.6));
      },
    });
    expect(probed).toHaveLength(2);
    expect(snap.accounts['a']?.fiveHour).toBe(0.25);
    expect(snap.accounts['a']?.sevenDayReset).toBe(2_000);
    // Persisted: a fresh read sees the same data.
    expect(readUsageSnapshot(c).accounts['b']?.sevenDay).toBe(0.6);
  });

  it('records renewals in the credential log, so a lost login is explainable', async () => {
    const { c, accounts } = setup(['a']);
    await refreshUsage(accounts, c, {
      probe: () => Promise.resolve(result(0.1, 0.2)),
      renew: () => Promise.resolve({ status: 'refreshed' }),
    });
    expect(readCredentialEvents(10, c).map((e) => e.kind)).toEqual(['renewed']);
  });

  it('records a refused renewal as needing sign-in, with the reason', async () => {
    const { c, accounts } = setup(['a']);
    await refreshUsage(accounts, c, {
      probe: () => Promise.resolve(result(0.1, 0.2)),
      renew: () => Promise.resolve({ status: 'needs-login', detail: 'invalid_grant' }),
    });
    const events = readCredentialEvents(10, c);
    expect(events[0]?.kind).toBe('needs-login');
    expect(events[0]?.detail).toBe('invalid_grant');
  });

  it('does not renew a profile that shares a login, but still reads its usage', async () => {
    const { c, accounts } = setup(['a', 'b']);
    // Same refresh token in both: renewing either would end the other.
    for (const account of accounts) {
      writeFileSync(
        path.join(account.dir, '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: { accessToken: `tok-${account.name}`, refreshToken: 'shared-refresh' },
        }),
        'utf8',
      );
    }
    let renewals = 0;
    const snap = await refreshUsage(accounts, c, {
      probe: () => Promise.resolve(result(0.3, 0.4)),
      renew: () => {
        renewals += 1;
        return Promise.resolve({ status: 'refreshed' });
      },
    });

    expect(renewals).toBe(0); // renewal is what destroys the sibling
    // Skipping the renewal must not skip the ACCOUNT: usage still updates, and
    // the entry is stamped, so it does not stay stale and get retried forever.
    expect(snap.accounts['a']?.fiveHour).toBe(0.3);
    expect(snap.accounts['b']?.at).toBeGreaterThan(0);
  });

  it('records the refusal only when a renewal was actually due, not every refresh', async () => {
    const { c, accounts } = setup(['a', 'b']);
    // Shared login, but both tokens are valid for hours: nothing was due, so
    // there is nothing to report. Logging here would append on every refresh.
    for (const account of accounts) {
      writeFileSync(
        path.join(account.dir, '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: `tok-${account.name}`,
            refreshToken: 'shared-refresh',
            expiresAt: Date.now() + 6 * 60 * 60_000,
          },
        }),
        'utf8',
      );
    }
    await refreshUsage(accounts, c, { probe: () => Promise.resolve(result(0.1, 0.2)) });
    expect(readCredentialEvents(10, c)).toHaveLength(0);
  });

  it('respects the TTL: fresh entries are not refetched', async () => {
    const { c, accounts } = setup(['a']);
    let calls = 0;
    const probe = (): Promise<LimitProbeResult> => {
      calls += 1;
      return Promise.resolve(result(0.1, 0.2));
    };
    await refreshUsage(accounts, c, { probe });
    await refreshUsage(accounts, c, { probe }); // within TTL: no refetch
    expect(calls).toBe(1);
    // Past the TTL it refetches.
    await refreshUsage(accounts, c, { probe, now: () => Date.now() + 10 * 60_000 });
    expect(calls).toBe(2);
  });

  it('skips logged-out accounts and stores nulls on probe failure (retry only after TTL)', async () => {
    const { c, accounts } = setup(['a']);
    const out = { name: 'out', dir: path.join(path.dirname(accounts[0]!.dir), 'out') };
    mkdirSync(out.dir, { recursive: true }); // no credentials: logged out
    let calls = 0;
    const probe = (): Promise<LimitProbeResult> => {
      calls += 1;
      return Promise.reject(new Error('offline'));
    };
    const snap = await refreshUsage([...accounts, out], c, { probe });
    expect(calls).toBe(1); // only the logged-in account was probed
    expect(snap.accounts['a']).toMatchObject({ fiveHour: null, sevenDay: null });
    expect(snap.accounts['out']).toBeUndefined();
    await refreshUsage(accounts, c, { probe }); // failure is cached within TTL
    expect(calls).toBe(1);
  });
});
