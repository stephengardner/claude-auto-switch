import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { forgetUsage, refreshUsage, readUsageSnapshot, renewIdleLogin, writeUsageSnapshot } from './usage-store.js';
import { renewOneAtATime } from './renew-one-at-a-time.js';
import type { LimitProbeResult } from './limit-probe.js';
import { readCredentialEvents } from '../accounts/credential-log.js';
import { takeLease } from '../session/lease.js';
import { rememberDeadLogin } from './dead-login-store.js';
import { credentialFileFingerprint } from '../accounts/credential-vault.js';
import { readEvents } from '../events/log.js';
import { configHome } from '../config/paths.js';

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

  it('writes one renewal down once, when two callers share it', async () => {
    const { c, accounts } = setup(['a']);
    const oneAtATime = renewOneAtATime();
    const renew = () =>
      oneAtATime('the one login', () => new Promise((resolve) => setTimeout(() => resolve({ status: 'refreshed' }), 20)));
    await Promise.all([
      renewIdleLogin(accounts[0]!, accounts, c, { renew, editorAccount: null }),
      renewIdleLogin(accounts[0]!, accounts, c, { renew, editorAccount: null }),
    ]);
    // Repeats are folded into one entry with a count, so the count is what says it.
    expect(readCredentialEvents(10, c).map((e) => [e.kind, e.count ?? 1])).toEqual([['renewed', 1]]);
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

    it('IS renewed while the editor may be using it, since Claude renews it under the same lock', async () => {
      // The editor's Claude reads this profile's login through the pointer and
      // renews it under <config dir>/.oauth_refresh.lock, the lock ccx takes in
      // this same folder, reading it again there and sending nothing when it
      // changed (Claude Code 2.1.294 to 2.1.299). So a renewal by ccx is one
      // the editor picks up rather than one that signs it out.
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

      expect(renewed.some((d) => d.includes('ide'))).toBe(true);
      expect(renewed.some((d) => d.includes('other'))).toBe(true);
      expect(readCredentialEvents(10, c).some((e) => e.detail?.includes('editor'))).toBe(false);
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

describe('a session that starts while the usage refresh is running', () => {
  it('is not renewed out from under, even though the lease came after the snapshot', async () => {
    // The refresh reads leases once, then makes a network call per account and
    // sleeps between them, so seconds pass. A session claiming an account in
    // that window would have been invisible, and renewing rotates the token out
    // from under it.
    const { c, accounts } = setup(['first', 'later']);
    const home = c.env.CLAUDE_AUTO_SWITCH_HOME as string;
    const renewed: string[] = [];
    const probed: string[] = [];
    let claimed = false;

    await refreshUsage(accounts, c, {
      probe: (file) => {
        probed.push(file);
        // Stands in for the network call. While the FIRST account is being
        // probed, a session claims the second one, which is invisible to the
        // lease map read before the loop started.
        if (!claimed && file.includes('first')) {
          takeLease('later', path.join(home, 'live'), c);
          claimed = true;
        }
        return Promise.resolve(result(0.1, 0.2));
      },
      renew: (dir) => {
        renewed.push(dir);
        return Promise.resolve({ status: 'refreshed' });
      },
    });

    expect(renewed).toContain(accounts[0]!.dir); // nothing was using this one
    expect(renewed).not.toContain(accounts[1]!.dir); // claimed mid-refresh
    // The same fresh answer decides which credential to READ. The session that
    // started mid-refresh holds a newer copy than the profile, so probing the
    // profile would report usage for a credential nobody is using.
    expect(probed.some((file) => file.includes('live'))).toBe(true);
  });
});

describe('a shared login where only the OTHER profile is busy', () => {
  function shareLogin(dirs: string[], token: string): void {
    for (const dir of dirs) {
      writeFileSync(
        path.join(dir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: `access-${token}`, refreshToken: token } }),
        'utf8',
      );
    }
  }

  it('probes the credential the sibling session is actually using', async () => {
    // Refusing the renewal is only half the answer. The profiles share a login,
    // so the sibling's live session holds the fresher copy of it; reading this
    // profile instead reports usage for a credential nobody is using.
    const { c, accounts } = setup(['idle', 'busy']);
    shareLogin([accounts[0]!.dir, accounts[1]!.dir], 'refresh-shared');
    const home = c.env.CLAUDE_AUTO_SWITCH_HOME as string;
    const live = path.join(home, 'live-session');
    takeLease('busy', live, c);
    // Only the IDLE account is stale, so it is the only one probed. Otherwise
    // the busy account's own probe would satisfy the assertion below and the
    // test could not tell whether the idle one used the right credential.
    writeFileSync(
      path.join(home, 'usage-snapshot.json'),
      JSON.stringify({
        accounts: {
          busy: {
            fiveHour: 0.1,
            sevenDay: 0.2,
            fiveHourReset: null,
            sevenDayReset: null,
            at: Date.now(),
          },
        },
      }),
      'utf8',
    );

    const probed: string[] = [];
    const renewed: string[] = [];
    await refreshUsage(accounts, c, {
      probe: (file) => {
        probed.push(file);
        return Promise.resolve(result(0.1, 0.2));
      },
      renew: (dir) => {
        renewed.push(dir);
        return Promise.resolve({ status: 'refreshed' });
      },
    });

    expect(probed).toHaveLength(1);
    expect(probed[0]).toContain('live-session');
    // The sibling's session is the reason this one is not renewed either. Without
    // this the stub renewal has no observable effect, so a regression that renews
    // before probing would slip through a test named for the sibling being busy.
    expect(renewed).toEqual([]);
  });

  it('does not renew a profile that shares its login with the one the EDITOR is on', async () => {
    // Renewing a sibling rotates the token the editor is using, under the
    // sibling's own lock, which the editor's Claude does not take, and then
    // carries it into the editor's own file mid-session. The profile the
    // editor is on is renewed under the lock the editor's Claude takes too.
    const { c, accounts } = setup(['other', 'editor-one']);
    shareLogin([accounts[0]!.dir, accounts[1]!.dir], 'refresh-shared');
    const home = c.env.CLAUDE_AUTO_SWITCH_HOME as string;
    try {
      symlinkSync(accounts[1]!.dir, path.join(home, 'editor-active'), 'junction');
    } catch {
      symlinkSync(accounts[1]!.dir, path.join(home, 'editor-active'));
    }

    const renewed: string[] = [];
    await refreshUsage(accounts, c, {
      probe: () => Promise.resolve(result(0.1, 0.2)),
      renew: (dir) => {
        renewed.push(dir);
        return Promise.resolve({ status: 'refreshed' });
      },
    });

    // Processing the NON-editor profile first is the case that used to slip
    // through: it is not the editor account itself, so nothing stopped it.
    expect(renewed).toEqual([accounts[1]!.dir]);
  });
});

describe('whose login answers for an account, when a session is running', () => {
  /** Write the identity Claude records for a config directory. */
  function signedInAs(dir: string, email: string) {
    writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }), 'utf8');
  }

  function liveSession(home: string, name: string, token: string) {
    const dir = path.join(home, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `rt-${token}` } }),
      'utf8',
    );
    return dir;
  }

  it('uses the profile when the session directory is signed in as SOMEBODY ELSE', async () => {
    // The production failure. Sessions shared one directory, so the login in it
    // belonged to whichever account started last. Reading it filed that
    // account's usage under this one: augdog911 has 21% of its week used and
    // 35% of its Fable, and was recorded at 57% with Fable spent, then routed
    // around as out of room while its own numbers said it was fine.
    const { c, accounts } = setup(['maxed']);
    const home = path.dirname(path.dirname(accounts[0]!.dir));
    signedInAs(accounts[0]!.dir, 'augdog911@gmail.com');
    const shared = liveSession(home, 'shared-session', 'tok-someone-else');
    signedInAs(shared, 'contactshopsheriff@gmail.com');
    takeLease('maxed', shared, c);

    const probed: string[] = [];
    await refreshUsage(accounts, c, {
      probe: (file) => {
        probed.push(file);
        return Promise.resolve(result(0.03, 0.21));
      },
      renew: () => Promise.resolve({ status: 'not-needed' as const }),
    });

    expect(probed).toHaveLength(1);
    expect(probed[0]).toContain(path.join('profiles', 'maxed'));
    expect(probed[0]).not.toContain('shared-session');
  });

  it('still prefers the session copy when it IS this account', async () => {
    // A running Claude keeps its own copy fresher than the profile's, so this
    // has to keep working: the guard is about the wrong ACCOUNT, not about
    // distrusting live sessions.
    const { c, accounts } = setup(['solo']);
    const home = path.dirname(path.dirname(accounts[0]!.dir));
    signedInAs(accounts[0]!.dir, 'solo@example.com');
    const own = liveSession(home, 'own-session', 'tok-fresh');
    signedInAs(own, 'solo@example.com');
    takeLease('solo', own, c);

    const probed: string[] = [];
    await refreshUsage(accounts, c, {
      probe: (file) => {
        probed.push(file);
        return Promise.resolve(result(0.1, 0.2));
      },
      renew: () => Promise.resolve({ status: 'not-needed' as const }),
    });

    expect(probed[0]).toContain('own-session');
  });

  it('prefers the session copy when neither side records an identity', async () => {
    // Not knowing is not evidence of a mismatch. Falling back on unknown would
    // give a staler answer for no reason.
    const { c, accounts } = setup(['quiet']);
    const home = path.dirname(path.dirname(accounts[0]!.dir));
    const anon = liveSession(home, 'anon-session', 'tok-anon');
    takeLease('quiet', anon, c);

    const probed: string[] = [];
    await refreshUsage(accounts, c, {
      probe: (file) => {
        probed.push(file);
        return Promise.resolve(result(0.1, 0.2));
      },
      renew: () => Promise.resolve({ status: 'not-needed' as const }),
    });

    expect(probed[0]).toContain('anon-session');
  });
});

describe('a login the usage endpoint turns away', () => {
  const turnedAway: LimitProbeResult = {
    verdict: 'unknown',
    detail: 'status 401',
    rejected: { message: 'OAuth access token has been revoked.', token: 'fp' },
  };
  /** A probe that answers each look with the next of `answers`, the last one for good. */
  const answering = (...answers: LimitProbeResult[]) => {
    let at = 0;
    return () => Promise.resolve(answers[Math.min(at++, answers.length - 1)] as LimitProbeResult);
  };

  it('renews it at once, for the token turned away, and reads the usage again', async () => {
    const { c, accounts } = setup(['a']);
    const asked: Array<string | undefined> = [];
    const snap = await refreshUsage(accounts, c, {
      probe: answering(turnedAway, result(0.3, 0.4)),
      renew: (_dir, rejected) => {
        asked.push(rejected);
        return Promise.resolve({ status: rejected ? 'refreshed' : 'not-needed' });
      },
    });
    expect(asked).toEqual([undefined, 'fp']);
    expect(snap.accounts['a']?.fiveHour).toBe(0.3);
  });

  it('says so where the dashboard shows it when the token endpoint refuses the login', async () => {
    const { c, accounts } = setup(['a', 'b']);
    await refreshUsage(accounts, c, {
      probe: (file) => Promise.resolve(file.includes(`${path.sep}a${path.sep}`) ? turnedAway : result(0.1, 0.1)),
      renew: (_dir, rejected) =>
        Promise.resolve(
          rejected
            ? { status: 'needs-login', detail: 'token endpoint 400: {"error": "invalid_grant", "error_description": "account_on_hold"}' }
            : { status: 'not-needed' },
        ),
    });
    expect(readCredentialEvents(10, c).map((e) => [e.account, e.kind])).toEqual([['a', 'needs-login']]);
    const said = readEvents(configHome(c), 10).filter((e) => e.kind === 'signed-out');
    expect(said.map((e) => e.msg)).toEqual(['"a" is on hold at Anthropic (claude.ai/restricted), so it is out of rotation']);
  });

  it('says nothing more about a refusal that was already known', async () => {
    const { c, accounts } = setup(['a']);
    await refreshUsage(accounts, c, {
      probe: answering(turnedAway),
      renew: (_dir, rejected) =>
        Promise.resolve(rejected ? { status: 'needs-login', detail: 'invalid_grant', alreadyKnown: true } : { status: 'not-needed' }),
    });
    expect(readEvents(configHome(c), 10).filter((e) => e.kind === 'signed-out')).toEqual([]);
  });

  it('never renews a login a running session is using, even when its token is turned away', async () => {
    const { c, accounts } = setup(['busy']);
    const sessionDir = path.join(c.env.CLAUDE_AUTO_SWITCH_HOME as string, 'live-session');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok-live', refreshToken: 'rt-live' } }),
      'utf8',
    );
    takeLease('busy', sessionDir, c);
    const asked: Array<string | undefined> = [];
    await refreshUsage(accounts, c, {
      probe: answering(turnedAway),
      renew: (_dir, rejected) => {
        asked.push(rejected);
        return Promise.resolve({ status: 'refreshed' });
      },
    });
    expect(asked).toEqual([]);
  });
});

describe('an account with no 5-hour limit, in the stored usage', () => {
  const verified: LimitProbeResult = {
    verdict: 'allowed',
    noFiveHourLimit: true,
    sevenDay: 0.28,
    sevenDayReset: 2_000,
  };

  it('keeps that it has none, apart from a 5-hour number nobody read', async () => {
    const { c, accounts } = setup(['v']);
    await refreshUsage(accounts, c, { probe: () => Promise.resolve(verified) });
    const entry = readUsageSnapshot(c).accounts['v'];
    expect(entry).toMatchObject({ fiveHour: null, fiveHourReset: null, noFiveHourLimit: true, sevenDay: 0.28 });
  });

  it('drops it as soon as the account reads with a 5-hour window again', async () => {
    const { c, accounts } = setup(['v']);
    let answer: LimitProbeResult = verified;
    const probe = (): Promise<LimitProbeResult> => Promise.resolve(answer);
    await refreshUsage(accounts, c, { probe });
    answer = result(0.3, 0.4);
    await refreshUsage(accounts, c, { probe, now: () => Date.now() + 10 * 60_000 });
    const entry = readUsageSnapshot(c).accounts['v'];
    expect(entry?.fiveHour).toBe(0.3);
    expect(entry?.noFiveHourLimit).toBeUndefined();
  });

  it('keeps it through a read that fails, like the rest of the last numbers', async () => {
    const { c, accounts } = setup(['v']);
    await refreshUsage(accounts, c, { probe: () => Promise.resolve(verified) });
    await refreshUsage(accounts, c, {
      probe: () => Promise.resolve({ verdict: 'unknown' }),
      now: () => Date.now() + 10 * 60_000,
    });
    expect(readUsageSnapshot(c).accounts['v']?.noFiveHourLimit).toBe(true);
  });

  it('keeps it through an answer that reads the week but cannot tell about the 5-hour window', async () => {
    // No `limits` list: the probe claims neither way, so the fact stands.
    const { c, accounts } = setup(['v']);
    await refreshUsage(accounts, c, { probe: () => Promise.resolve(verified) });
    await refreshUsage(accounts, c, {
      probe: () => Promise.resolve({ verdict: 'allowed', sevenDay: 0.3, sevenDayReset: 2_000 }),
      now: () => Date.now() + 10 * 60_000,
    });
    expect(readUsageSnapshot(c).accounts['v']).toMatchObject({ noFiveHourLimit: true, sevenDay: 0.3 });
  });

  it('keeps the window cost it learned while it still had a 5-hour window', async () => {
    const { c, accounts } = setup(['v']);
    const t0 = Date.now();
    const reading = (fiveHour: number, sevenDay: number): LimitProbeResult => ({
      verdict: 'allowed',
      fiveHour,
      sevenDay,
      fiveHourReset: t0 + 3 * 3_600_000,
      sevenDayReset: t0 + 4 * 86_400_000,
    });
    let answer = reading(0.1, 0.3);
    const probe = (): Promise<LimitProbeResult> => Promise.resolve(answer);
    await refreshUsage(accounts, c, { probe, now: () => t0 });
    answer = reading(0.5, 0.38);
    await refreshUsage(accounts, c, { probe, now: () => t0 + 10 * 60_000 });
    const learned = readUsageSnapshot(c).accounts['v']?.windowCost;
    expect(typeof learned).toBe('number');
    answer = { ...verified, sevenDayReset: t0 + 4 * 86_400_000 };
    await refreshUsage(accounts, c, { probe, now: () => t0 + 20 * 60_000 });
    expect(readUsageSnapshot(c).accounts['v']).toMatchObject({ noFiveHourLimit: true, windowCost: learned });
  });
});

describe('a refresh and another writer at once', () => {
  it('puts back only what it measured, over what is on disk when it writes', async () => {
    // The refresh spends seconds on the network between reading the snapshot
    // and writing it. A rename, a removal or another session's refresh in that
    // time used to be undone by the whole stale snapshot going back on disk:
    // a removed account's entry came back, a renamed one's was lost.
    const { c, accounts } = setup(['a']);
    writeUsageSnapshot(
      {
        accounts: {
          removed: { fiveHour: null, noFiveHourLimit: true, sevenDay: 0.2, fiveHourReset: null, sevenDayReset: null, at: Date.now() },
        },
      },
      c,
    );
    const snap = await refreshUsage(accounts, c, {
      probe: () => {
        // Meanwhile: one account removed, another moved to a new name.
        forgetUsage('removed', c);
        const now = readUsageSnapshot(c);
        now.accounts['renamed'] = { fiveHour: 0.4, sevenDay: 0.5, fiveHourReset: null, sevenDayReset: null, at: Date.now() };
        writeUsageSnapshot(now, c);
        return Promise.resolve(result(0.25, 0.6));
      },
    });
    const disk = readUsageSnapshot(c).accounts;
    expect(Object.keys(disk).sort()).toEqual(['a', 'renamed']);
    expect(disk['a']?.fiveHour).toBe(0.25);
    expect(Object.keys(snap.accounts).sort()).toEqual(['a', 'renamed']);
  });
});

describe('what a refresh puts back when another writer got there first', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    fiveHour: 0.1,
    sevenDay: 0.2,
    fiveHourReset: null,
    sevenDayReset: null,
    at: 1,
    ...over,
  });
  const stale = { now: () => Date.now() + 10 * 60_000 };

  it('a failed read leaves a newer entry alone', async () => {
    const { c, accounts } = setup(['a']);
    writeUsageSnapshot({ accounts: { a: entry({ noFiveHourLimit: true, fiveHour: null }) } }, c);
    await refreshUsage(accounts, c, {
      ...stale,
      probe: () => {
        writeUsageSnapshot({ accounts: { a: entry({ fiveHour: 0.3, at: Date.now() }) } }, c);
        return Promise.resolve({ verdict: 'unknown' });
      },
    });
    expect(readUsageSnapshot(c).accounts['a']).toMatchObject({ fiveHour: 0.3 });
    expect(readUsageSnapshot(c).accounts['a']?.noFiveHourLimit).toBeUndefined();
  });

  it('an older reading leaves a newer one alone', async () => {
    const { c, accounts } = setup(['a']);
    writeUsageSnapshot({ accounts: { a: entry() } }, c);
    await refreshUsage(accounts, c, {
      probe: () => {
        writeUsageSnapshot({ accounts: { a: entry({ fiveHour: 0.7, at: Date.now() + 60 * 60_000 }) } }, c);
        return Promise.resolve(result(0.25, 0.6));
      },
      ...stale,
      now: () => Date.now() + 10 * 60_000,
    });
    expect(readUsageSnapshot(c).accounts['a']?.fiveHour).toBe(0.7);
  });

  it('a reading that cannot tell takes "no 5-hour limit" from the newest entry, not the one it started from', async () => {
    const { c, accounts } = setup(['a']);
    writeUsageSnapshot({ accounts: { a: entry({ noFiveHourLimit: true, fiveHour: null }) } }, c);
    await refreshUsage(accounts, c, {
      ...stale,
      probe: () => {
        // Meanwhile another session read a 5-hour window on it.
        writeUsageSnapshot({ accounts: { a: entry({ fiveHour: 0.3, at: Date.now() }) } }, c);
        return Promise.resolve({ verdict: 'allowed', sevenDay: 0.4, sevenDayReset: 2_000 });
      },
    });
    const a = readUsageSnapshot(c).accounts['a'];
    expect(a?.sevenDay).toBe(0.4);
    expect(a?.noFiveHourLimit).toBeUndefined();
  });

  it('does not put back an account removed or renamed while it was being read', async () => {
    const { c, accounts } = setup(['a']);
    writeUsageSnapshot({ accounts: { a: entry({ noFiveHourLimit: true, fiveHour: null }) } }, c);
    await refreshUsage(accounts, c, {
      ...stale,
      probe: () => {
        forgetUsage('a', c);
        return Promise.resolve(result(0.25, 0.6));
      },
    });
    expect(readUsageSnapshot(c).accounts['a']).toBeUndefined();
  });
});

describe('an account removed and added again while it was being read', () => {
  it('does not hand the new account what was read for the old one', async () => {
    // The order CodeRabbit asked about on #185: a refresh starts reading "a",
    // "a" is removed and a different account registered as "a" (whose add
    // drops anything stored under the name), then the old read finishes.
    const { c, accounts } = setup(['a']);
    writeUsageSnapshot(
      { accounts: { a: { fiveHour: null, noFiveHourLimit: true, sevenDay: 0.2, fiveHourReset: null, sevenDayReset: null, at: 1 } } },
      c,
    );
    await refreshUsage(accounts, c, {
      now: () => Date.now() + 10 * 60_000,
      probe: () => {
        forgetUsage('a', c); // ccx remove a
        forgetUsage('a', c); // ccx add a: drops anything left under the name
        return Promise.resolve({ verdict: 'allowed', noFiveHourLimit: true, sevenDay: 0.3, sevenDayReset: 2_000 });
      },
    });
    expect(readUsageSnapshot(c).accounts['a']).toBeUndefined();
  });
});

describe('a usage field this version does not know', () => {
  it('survives a refresh that cannot read the account, and any other write', async () => {
    const { c, accounts } = setup(['a']);
    writeUsageSnapshot(
      {
        accounts: {
          a: { fiveHour: 0.1, sevenDay: 0.2, fiveHourReset: null, sevenDayReset: null, at: 1, fromTheFuture: true } as never,
          other: { fiveHour: 0.1, sevenDay: 0.2, fiveHourReset: null, sevenDayReset: null, at: Date.now(), fromTheFuture: 2 } as never,
        },
      },
      c,
    );
    await refreshUsage(accounts, c, { probe: () => Promise.resolve({ verdict: 'unknown' }) });
    const raw = JSON.parse(readFileSync(path.join(configHome(c), 'usage-snapshot.json'), 'utf8')) as {
      accounts: Record<string, Record<string, unknown>>;
    };
    expect(raw.accounts['a']?.['fromTheFuture']).toBe(true);
    expect(raw.accounts['other']?.['fromTheFuture']).toBe(2);
  });
});
