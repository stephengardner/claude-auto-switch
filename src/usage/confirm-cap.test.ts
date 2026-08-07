import { describe, it, expect } from 'vitest';
import { confirmCap } from './confirm-cap.js';
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
