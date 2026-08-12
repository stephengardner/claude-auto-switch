import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { confirmCap, confirmSessionCap } from './confirm-cap.js';
import type { LimitProbeResult } from './limit-probe.js';

const probing = (result: LimitProbeResult, seen?: string[]) => (file: string) => {
  seen?.push(file);
  return Promise.resolve(result);
};

describe('confirmCap', () => {
  it('asks the ACCOUNT being capped, not the shared session directory', async () => {
    // The production failure: with two runs sharing one session directory, an
    // exhausted account answered for a healthy one and the healthy one took the
    // cap. Five accounts went down in 87 seconds that way.
    const asked: string[] = [];
    await confirmCap('/profiles/second', 'limit reached', {
      probe: probing({ verdict: 'allowed' }, asked),
      sessionCredentials: '/session/.credentials.json',
    });
    expect(asked[0]).toContain('second');
    expect(asked[0]).not.toContain('session');
  });

  it('records a Fable-only limit AS Fable, so the account still runs on Opus', async () => {
    // Dropping the scope is what turned "Fable is spent" into "this account is
    // unusable", and then into "every account has hit its limit".
    const decision = await confirmCap('/profiles/second', "you've reached your Fable 5 limit", {
      probe: probing({
        verdict: 'limited',
        limitedModel: 'Fable',
        fiveHour: 0.03,
        sevenDay: 0.74,
        models: [{ name: 'Fable', utilization: 1, resetsAt: 999 }],
      }),
    });
    expect(decision.limited).toBe(true);
    expect(decision.model).toBe('Fable');
    expect(decision.resetAt).toBe(999);
  });

  it('records a genuinely spent account as account-wide, with no model', async () => {
    const decision = await confirmCap('/profiles/main', 'usage limit reached', {
      probe: probing({ verdict: 'limited', fiveHour: 0.0, sevenDay: 1, sevenDayReset: 4242 }),
    });
    expect(decision.limited).toBe(true);
    expect(decision.model).toBeUndefined();
    expect(decision.resetAt).toBe(4242);
  });

  it('uses the FIVE-HOUR reset when that is the window that is spent', async () => {
    // Capping until the weekly reset when only the five-hour window is gone
    // would park a working account for days.
    const decision = await confirmCap('/profiles/contactss', 'limit', {
      probe: probing({
        verdict: 'limited',
        fiveHour: 1,
        sevenDay: 0.2,
        fiveHourReset: 111,
        sevenDayReset: 999999,
      }),
    });
    expect(decision.resetAt).toBe(111);
  });

  it('REFUSES to cap when the API does not confirm it', async () => {
    // Cap-looking text is a trigger, never a verdict: resumed conversations
    // replay old limit messages, and code on screen can talk about rate limits.
    for (const verdict of ['allowed', 'unknown'] as const) {
      const decision = await confirmCap('/profiles/second', 'rate limit', {
        probe: probing({ verdict }),
      });
      expect(decision.limited, verdict).toBe(false);
    }
  });

  it('refuses when the endpoint cannot be reached at all', async () => {
    // Not proven must never become a cap. A real limit will trigger this again;
    // a healthy account wrongly capped stays broken for hours.
    const decision = await confirmCap('/profiles/second', 'limit', {
      probe: probing({ verdict: 'unknown', detail: 'status 429', retryAfterMs: 5000 }),
    });
    expect(decision.limited).toBe(false);
    expect(decision.detail).toBe('status 429');
  });

  it('refuses when there is no credential to ask', async () => {
    const decision = await confirmCap(null, 'limit', { probe: probing({ verdict: 'limited' }) });
    expect(decision.limited).toBe(false);
  });
});

describe('whose login answers for an interactive session', () => {
  const probing = (result: LimitProbeResult) => {
    const asked: string[] = [];
    return {
      asked,
      probe: (file: string) => {
        asked.push(file);
        return Promise.resolve(result);
      },
    };
  };

  function loginDir(name: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), `cas-cap-${name}-`));
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: `tok-${name}`, refreshToken: `rt-${name}` } }),
    );
    return dir;
  }

  it('asks the SESSION credential: that login rendered the banner on screen', async () => {
    // The deadlock this ends: a session signed in as somebody else showed that
    // account's limit banner, the believed profile answered "not capped", and
    // the switch never came. With one directory per session, the session's own
    // login IS the identity on screen; the profile is only a guess.
    const session = loginDir('session');
    const profile = loginDir('profile');
    const { asked, probe } = probing({ verdict: 'limited', fiveHour: 1, fiveHourReset: 42 });
    const decision = await confirmSessionCap(
      { sessionDir: session, believedDir: profile },
      'limit reached',
      { probe },
    );
    expect(decision.limited).toBe(true);
    expect(decision.askedOf).toBe('session');
    expect(asked[0]).toContain(session);
  });

  it('falls back to the believed profile when the session has no usable login', async () => {
    // A signed-out session dir holds a credential file with EMPTY tokens; the
    // profile is the better guess then, and the decision says which was asked.
    const session = mkdtempSync(path.join(tmpdir(), 'cas-cap-empty-'));
    writeFileSync(
      path.join(session, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: '' } }),
    );
    const profile = loginDir('believed');
    const { asked, probe } = probing({ verdict: 'allowed' });
    const decision = await confirmSessionCap(
      { sessionDir: session, believedDir: profile },
      'limit reached',
      { probe },
    );
    expect(decision.askedOf).toBe('profile');
    expect(asked[0]).toContain(profile);
  });

  it('refuses outright when neither side has a credential to ask', async () => {
    const session = mkdtempSync(path.join(tmpdir(), 'cas-cap-none-'));
    const { asked, probe } = probing({ verdict: 'limited', fiveHour: 1 });
    const decision = await confirmSessionCap(
      { sessionDir: session, believedDir: null },
      'limit reached',
      { probe },
    );
    expect(decision.limited).toBe(false);
    expect(asked).toHaveLength(0);
  });
});

describe('how WIDE a confirmed limit really is', () => {
  const probing = (result: LimitProbeResult) => () => Promise.resolve(result);

  it('caps the MODEL, not the account, when no account window is spent', async () => {
    // The production failure, twice in one day. The account-wide branch never
    // checked that an account-wide window was actually spent: any "limited"
    // verdict without a named model became an account-wide cap. An account with
    // 2% of its five-hour window used and 57% of its week was taken out of
    // rotation for five hours because its Fable was gone.
    const decision = await confirmCap('/profiles/maxed', 'limit reached', {
      probe: probing({
        verdict: 'limited',
        fiveHour: 0.02,
        sevenDay: 0.57,
        models: [{ name: 'Fable', utilization: 1, resetsAt: 777 }],
      }),
    });
    expect(decision.limited).toBe(true);
    expect(decision.model).toBe('Fable');
    expect(decision.resetAt).toBe(777);
  });

  it('uses the spent window’s own reset, not a fixed guess', async () => {
    // phx was capped for five hours by the default backoff when its five-hour
    // window reopened in sixteen minutes, so the only account with Fable left
    // stayed locked out long after it had recovered.
    const decision = await confirmCap('/profiles/phx', 'limit reached', {
      probe: probing({
        verdict: 'limited',
        fiveHour: 1,
        fiveHourReset: 555,
        sevenDay: 0.44,
        sevenDayReset: 99999,
      }),
    });
    expect(decision.limited).toBe(true);
    expect(decision.model).toBeUndefined();
    expect(decision.resetAt).toBe(555);
  });

  it('refuses to cap when nothing measurable is spent', async () => {
    // "Limited" with every window showing room is not something to act on, and
    // guessing account-wide is the most expensive guess available.
    const decision = await confirmCap('/profiles/main', 'limit reached', {
      probe: probing({ verdict: 'limited', fiveHour: 0.1, sevenDay: 0.2, models: [{ name: 'Fable', utilization: 0.35 }] }),
    });
    expect(decision.limited).toBe(false);
  });
});
