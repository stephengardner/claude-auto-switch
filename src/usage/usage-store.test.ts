import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { refreshUsage, readUsageSnapshot } from './usage-store.js';
import type { LimitProbeResult } from './limit-probe.js';
import { readCredentialEvents } from '../accounts/credential-log.js';
import { takeLease } from '../session/lease.js';
import { rememberDeadLogin } from './dead-login-store.js';
import { credentialFileFingerprint } from '../accounts/credential-vault.js';

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

  it('renews a profile that shares a login, and reads its usage', async () => {
    const { c, accounts } = setup(['a', 'b']);
    // Same refresh token in both. Renewing rotates it and retires the old one,
    // so this used to be refused outright. That was symmetric, so NEITHER half
    // was ever renewed and both tokens expired. The renewal is carried across
    // to the sibling now, which is what makes renewing safe here.
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

    // Renewed rather than skipped: the sibling is brought along, so nothing is
    // destroyed by it. Both accounts are processed, hence two renewals.
    expect(renewals).toBeGreaterThan(0);
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

  it('never renews a login a running session is using, and reads that live copy', async () => {
    // The whole reason leases exist. Renewing REPLACES a login, so renewing this
    // one would sign the running session out mid-work: the operator sees
    // "Login expired - please run /login" having done nothing.
    const { c, accounts } = setup(['busy', 'idle']);
    const sessionDir = path.join(
      c.env.CLAUDE_AUTO_SWITCH_HOME as string,
      'live-session',
    );
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok-live', refreshToken: 'rt-live' } }),
      'utf8',
    );
    takeLease('busy', sessionDir, c);

    const renewed: string[] = [];
    const probedFiles: string[] = [];
    const snap = await refreshUsage(accounts, c, {
      probe: (file) => {
        probedFiles.push(file);
        return Promise.resolve(result(0.5, 0.6));
      },
      renew: (dir) => {
        renewed.push(dir);
        return Promise.resolve({ status: 'refreshed' });
      },
    });

    expect(renewed.some((d) => d.includes('busy'))).toBe(false); // the live one: untouched
    expect(renewed.some((d) => d.includes('idle'))).toBe(true); // an idle one is safe
    // Usage still updates, read from the copy the session keeps fresh.
    expect(probedFiles.some((f) => f.startsWith(sessionDir))).toBe(true);
    expect(snap.accounts['busy']?.fiveHour).toBe(0.5);
  });

  describe('an account the editor is pointed at', () => {
    /** Point the editor pointer at `dir`, the way `ccx editor on` does. */
    function pointEditorAt(home: string, dir: string): void {
      try {
        symlinkSync(dir, path.join(home, 'editor-active'), 'junction');
      } catch {
        symlinkSync(dir, path.join(home, 'editor-active'));
      }
    }

    /** Give an account a login that expired `minutesAgo`. */
    function expiredLogin(dir: string, name: string, minutesAgo: number): void {
      writeFileSync(
        path.join(dir, '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: `tok-${name}`,
            refreshToken: `rt-${name}`,
            expiresAt: Date.now() - minutesAgo * 60_000,
          },
        }),
        'utf8',
      );
    }

    it('is NOT renewed while it could still be in use', async () => {
      // The editor reads the login directly, so ccx cannot see its session. This
      // is the same failure as the terminal case: renewing signs the editor out.
      const { c, accounts } = setup(['ide', 'other']);
      const home = c.env.CLAUDE_AUTO_SWITCH_HOME as string;
      expiredLogin(accounts[0]!.dir, 'ide', 1);
      expiredLogin(accounts[1]!.dir, 'other', 1);
      pointEditorAt(home, accounts[0]!.dir);

      const renewed: string[] = [];
      await refreshUsage(accounts, c, {
        probe: () => Promise.resolve(result(0.2, 0.3)),
        renew: (dir) => {
          renewed.push(dir);
          return Promise.resolve({ status: 'refreshed' });
        },
      });

      expect(renewed.some((d) => d.includes('ide'))).toBe(false);
      expect(renewed.some((d) => d.includes('other'))).toBe(true); // not pointed at
      expect(readCredentialEvents(10, c).some((e) => e.detail?.includes('editor'))).toBe(true);
    });

    it('IS renewed once its login has been dead too long for anything to hold it', async () => {
      // Otherwise an idle editor account's usage would go stale for good. A live
      // Claude refreshes within minutes, so hours of nothing means nothing is
      // using it, and renewing is both safe and the only way to read its usage.
      const { c, accounts } = setup(['ide']);
      const home = c.env.CLAUDE_AUTO_SWITCH_HOME as string;
      expiredLogin(accounts[0]!.dir, 'ide', 120);
      pointEditorAt(home, accounts[0]!.dir);

      const renewed: string[] = [];
      await refreshUsage(accounts, c, {
        probe: () => Promise.resolve(result(0.2, 0.3)),
        renew: (dir) => {
          renewed.push(dir);
          return Promise.resolve({ status: 'refreshed' });
        },
      });

      expect(renewed).toHaveLength(1);
    });

    it('protects nothing when the editor integration is off', async () => {
      const { c, accounts } = setup(['ide']);
      expiredLogin(accounts[0]!.dir, 'ide', 1);
      // No pointer at all.
      const renewed: string[] = [];
      await refreshUsage(accounts, c, {
        probe: () => Promise.resolve(result(0.2, 0.3)),
        renew: (dir) => {
          renewed.push(dir);
          return Promise.resolve({ status: 'refreshed' });
        },
      });
      expect(renewed).toHaveLength(1);
    });
  });

  it('resumes renewing once the session that was using it is gone', async () => {
    const { c, accounts } = setup(['busy']);
    takeLease('busy', path.join(c.env.CLAUDE_AUTO_SWITCH_HOME as string, 'gone'), c);
    const renewed: string[] = [];
    await refreshUsage(accounts, c, {
      probe: () => Promise.resolve(result(0.1, 0.2)),
      renew: (dir) => {
        renewed.push(dir);
        return Promise.resolve({ status: 'refreshed' });
      },
      // The session died without cleaning up. Protection must not outlive it.
      leaseOptions: { isAlive: () => false },
    });
    expect(renewed).toHaveLength(1);
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

describe('a rejected profile credential while a session is live', () => {
  it('still refreshes usage for the leased account, reading the live copy', async () => {
    // The profile copy is the one that was refused. A running session keeps its
    // OWN copy fresh, so judging the account by the profile copy alone would
    // stop refreshing usage for the account being used right now, and the
    // rotation policy reads that usage to decide where to move next.
    const { c, accounts } = setup(['busy']);
    const live = path.join(c.env.CLAUDE_AUTO_SWITCH_HOME as string, 'live-session');
    mkdirSync(live, { recursive: true });
    writeFileSync(
      path.join(live, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok-live-and-working' } }),
      'utf8',
    );
    takeLease('busy', live, c);
    rememberDeadLogin(
      credentialFileFingerprint(accounts[0]!.dir),
      'token endpoint 400: invalid_grant',
      c,
    );

    const probed: string[] = [];
    const snap = await refreshUsage(accounts, c, {
      probe: (file) => {
        probed.push(file);
        return Promise.resolve(result(0.4, 0.5));
      },
      renew: () => Promise.resolve({ status: 'not-needed' }),
    });

    expect(probed).toHaveLength(1);
    expect(probed[0]).toContain('live-session');
    expect(snap.accounts.busy?.fiveHour).toBe(0.4);
  });

  it('skips a rejected account that no session is using', async () => {
    const { c, accounts } = setup(['idle']);
    rememberDeadLogin(
      credentialFileFingerprint(accounts[0]!.dir),
      'token endpoint 400: invalid_grant',
      c,
    );
    const probed: string[] = [];
    await refreshUsage(accounts, c, {
      probe: (file) => {
        probed.push(file);
        return Promise.resolve(result(0.1, 0.2));
      },
    });
    expect(probed).toEqual([]);
  });
});

describe('two profiles that share one login, during a usage refresh', () => {
  /** Give two profiles the same login, as a duplicate sign-in produces. */
  function shareLogin(dirs: string[], token: string): void {
    for (const dir of dirs) {
      writeFileSync(
        path.join(dir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: `access-${token}`, refreshToken: token } }),
        'utf8',
      );
    }
  }
  const refreshOf = (dir: string): string =>
    JSON.parse(readFileSync(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth.refreshToken;

  it('renews one of them and carries it to the other', async () => {
    // Refusing whenever a sibling existed was symmetric, so NEITHER half of a
    // duplicated account was ever renewed here: both tokens expired, their
    // usage became unreadable, and the rotation policy went blind on exactly
    // the accounts it was meant to choose between.
    const { c, accounts } = setup(['phx', 'maxed']);
    shareLogin([accounts[0]!.dir, accounts[1]!.dir], 'refresh-shared');

    await refreshUsage(accounts, c, {
      probe: () => Promise.resolve(result(0.1, 0.2)),
      // ONLY the first account can renew. Letting both renew would leave both
      // holding the new token either way, so the assertion below could not tell
      // carrying apart from two independent renewals.
      renew: (dir) => {
        if (dir !== accounts[0]!.dir) return Promise.resolve({ status: 'not-needed' });
        writeFileSync(
          path.join(dir, '.credentials.json'),
          JSON.stringify({ claudeAiOauth: { accessToken: 'access-new', refreshToken: 'refresh-new' } }),
          'utf8',
        );
        return Promise.resolve({ status: 'refreshed' });
      },
    });

    expect(refreshOf(accounts[0]!.dir)).toBe('refresh-new');
    // The only way this changed is by being carried across.
    expect(refreshOf(accounts[1]!.dir)).toBe('refresh-new');
  });

  it('still refuses when a session is using the profile that shares it', async () => {
    // The reason the original refusal existed: renewing rotates the token, and
    // a session holding that login would be signed out mid-work.
    const { c, accounts } = setup(['phx', 'maxed']);
    shareLogin([accounts[0]!.dir, accounts[1]!.dir], 'refresh-shared');
    takeLease('maxed', path.join(c.env.CLAUDE_AUTO_SWITCH_HOME as string, 'live'), c);

    const renewed: string[] = [];
    await refreshUsage(accounts, c, {
      probe: () => Promise.resolve(result(0.1, 0.2)),
      renew: (dir) => {
        renewed.push(dir);
        return Promise.resolve({ status: 'refreshed' });
      },
    });

    expect(renewed).not.toContain(accounts[0]!.dir);
    expect(refreshOf(accounts[0]!.dir)).toBe('refresh-shared');
  });
});
