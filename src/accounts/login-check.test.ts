import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { askAboutLogin, isOnHold, loginOnHold } from './login-check.js';
import { credentialFileFingerprint, credentialPath } from './credential-vault.js';
import { rememberDeadLogin } from '../usage/dead-login-store.js';
import type { LimitProbeResult } from '../usage/limit-probe.js';
import type { RefreshOutcome } from '../usage/oauth-refresh.js';

/** The token endpoint's answer for an account Anthropic had put on hold (measured). */
const ON_HOLD =
  'token endpoint 400: {"error": "invalid_grant", "error_description": "account_on_hold", "error_uri": "https://claude.ai/restricted"}';
const SIGNED_OUT =
  'token endpoint 400: {"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}';

/** A profile with a login of its own: two profiles must never share a fingerprint by accident. */
const dir = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'cas-login-check-'));
  writeFileSync(credentialPath(d), JSON.stringify({ claudeAiOauth: { accessToken: d, refreshToken: 'r' } }));
  return d;
};
const read = (result: LimitProbeResult) => async () => result;
const turnedAway: LimitProbeResult = {
  verdict: 'unknown',
  detail: 'status 401',
  rejected: { message: 'OAuth access token has been revoked.', token: 'fp' },
};

describe('asking Anthropic whether a login still works', () => {
  it('works when its usage can be read, and nothing is renewed', async () => {
    const renewed: string[] = [];
    const check = await askAboutLogin(dir(), {
      probe: read({ verdict: 'allowed', fiveHour: 0.1, sevenDay: 0.2 }),
      renew: async () => {
        renewed.push('renew');
        return { status: 'refreshed' };
      },
    });
    expect(check).toEqual({ state: 'works' });
    expect(renewed).toEqual([]);
  });

  it('renews the very token that was turned away, and works when that succeeds', async () => {
    const asked: Array<string | undefined> = [];
    const check = await askAboutLogin(dir(), {
      probe: read(turnedAway),
      renew: async (_dir, rejected) => {
        asked.push(rejected);
        return { status: 'refreshed' };
      },
    });
    expect(check).toEqual({ state: 'renewed' });
    expect(asked).toEqual(['fp']);
  });

  it('is finished when the token endpoint refuses the login, and says when it is on hold', async () => {
    const refuse = (detail: string) => async (): Promise<RefreshOutcome> => ({ status: 'needs-login', detail });
    expect(await askAboutLogin(dir(), { probe: read(turnedAway), renew: refuse(SIGNED_OUT) })).toEqual({
      state: 'finished',
      detail: SIGNED_OUT,
      onHold: false,
    });
    expect(await askAboutLogin(dir(), { probe: read(turnedAway), renew: refuse(ON_HOLD) })).toEqual({
      state: 'finished',
      detail: ON_HOLD,
      onHold: true,
    });
  });

  it('cannot tell when the usage endpoint says anything else, and renews nothing', async () => {
    let renewed = 0;
    const renew = async (): Promise<RefreshOutcome> => {
      renewed += 1;
      return { status: 'refreshed' };
    };
    for (const result of [
      { verdict: 'unknown', detail: 'status 429' },
      { verdict: 'unknown', detail: 'offline' },
    ] as LimitProbeResult[]) {
      expect((await askAboutLogin(dir(), { probe: read(result), renew })).state).toBe('unknown');
    }
    expect(renewed).toBe(0);
  });

  it('cannot tell when the renewal could not be made, or the login changed meanwhile', async () => {
    for (const status of ['busy', 'unavailable', 'not-needed'] as const) {
      const check = await askAboutLogin(dir(), { probe: read(turnedAway), renew: async () => ({ status }) });
      expect(check.state, status).toBe('unknown');
    }
  });
});

describe('an account on hold', () => {
  it('is read from what the token endpoint said, and from nothing else', () => {
    expect(isOnHold(ON_HOLD)).toBe(true);
    expect(isOnHold(SIGNED_OUT)).toBe(false);
    expect(isOnHold(undefined)).toBe(false);
  });

  it('is the stored login refused that way, until the login changes', () => {
    const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: mkdtempSync(path.join(tmpdir(), 'cas-hold-')) } };
    const held = dir();
    const out = dir();
    rememberDeadLogin(credentialFileFingerprint(held), ON_HOLD, ctx);
    rememberDeadLogin(credentialFileFingerprint(out), SIGNED_OUT, ctx);
    expect(loginOnHold(held, ctx)).toBe(true);
    expect(loginOnHold(out, ctx)).toBe(false);
    // Signing in again writes a new login, which nothing has refused.
    writeFileSync(credentialPath(held), JSON.stringify({ claudeAiOauth: { accessToken: 'b', refreshToken: 's' } }));
    expect(loginOnHold(held, ctx)).toBe(false);
  });
});

describe('a login lent to this machine, turned away', () => {
  it('is finished as a lend, so the session moves on without being told to sign in', async () => {
    const check = await askAboutLogin(dir(), {
      probe: read(turnedAway),
      renew: async (): Promise<RefreshOutcome> => ({ status: 'lent', detail: 'a login lent to this machine' }),
    });
    expect(check).toEqual({ state: 'finished', detail: 'OAuth access token has been revoked.', onHold: false, lent: true });
  });
});
