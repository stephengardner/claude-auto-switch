import { describe, it, expect } from 'vitest';
import { toStatePayload, STATE_SCHEMA_VERSION } from './state-payload.js';
import type { DashboardAccount, DashboardSnapshot } from './render.js';

const NOW = Date.UTC(2026, 7, 16, 12, 0);
const HOUR = 3600_000;

function account(over: Partial<DashboardAccount> = {}): DashboardAccount {
  return {
    name: 'work',
    loggedIn: true,
    active: false,
    enabled: true,
    priority: 0,
    ...over,
  };
}

function snapshot(accounts: DashboardAccount[], over: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return { accounts, events: [], now: NOW, refreshMs: 3000, ...over };
}

describe('the state another program reads', () => {
  it('carries a schema version and the build that produced it', () => {
    // A reader has to be able to tell old data from new, and to tell whether
    // the shape it was written against is the shape it is holding.
    const payload = toStatePayload(snapshot([account()], { version: '1.46.0' }));
    expect(payload.schemaVersion).toBe(STATE_SCHEMA_VERSION);
    expect(payload.ccxVersion).toBe('1.46.0');
    expect(payload.now).toBe(NOW);
  });

  it('answers "can I use this account" rather than only handing over numbers', () => {
    // The point of shipping the derived status. A consumer re-deriving this
    // from the raw windows would be reimplementing a rule this codebase has
    // already got wrong once: the table printed "ready" beside a window at
    // 100% while rotation refused to touch that account.
    const payload = toStatePayload(
      snapshot(
        [
          account({
            name: 'spent',
            usage: {
              fiveHour: 1,
              sevenDay: 0.2,
              fiveHourReset: NOW + 3 * HOUR,
              sevenDayReset: NOW + 40 * HOUR,
            },
          }),
        ],
        { model: 'fable' },
      ),
    );
    const [a] = payload.accounts;
    expect(a?.status.state).toBe('blocked');
    expect(a?.status.label).toBe('5h');
    expect(a?.status.until).toBe(NOW + 3 * HOUR);
  });

  it('names the model and when it returns, the same as the screen does', () => {
    const payload = toStatePayload(
      snapshot(
        [
          account({
            name: 'maxed',
            usage: {
              fiveHour: 0.05,
              sevenDay: 0.8,
              fiveHourReset: NOW + HOUR,
              sevenDayReset: NOW + 40 * HOUR,
              models: [{ name: 'Fable', utilization: 1, resetsAt: NOW + 10 * HOUR }],
            },
          }),
        ],
        { model: 'fable' },
      ),
    );
    const [a] = payload.accounts;
    expect(a?.status.label).toBe('fable');
    expect(a?.status.until).toBe(NOW + 10 * HOUR);
  });

  it('lists EVERYTHING blocking, not only the one it names', () => {
    // The name answers "when can I use this"; the list answers "why". A UI
    // that wants to explain the wait needs both.
    const payload = toStatePayload(
      snapshot(
        [
          account({
            cappedUntil: NOW + 2 * HOUR,
            usage: { fiveHour: 1, sevenDay: 1, fiveHourReset: NOW + HOUR, sevenDayReset: NOW + 50 * HOUR },
          }),
        ],
        { model: 'fable' },
      ),
    );
    const labels = payload.accounts[0]?.status.blockedBy.map((c) => c.label);
    expect(labels).toEqual(['capped', '5h', 'week']);
    // And the wait is until the LAST one lifts, not the first.
    expect(payload.accounts[0]?.status.until).toBe(NOW + 50 * HOUR);
  });

  it('says plainly when an account is ready, disabled or signed out', () => {
    const payload = toStatePayload(
      snapshot([
        account({ name: 'fine' }),
        account({ name: 'off', enabled: false }),
        account({ name: 'out', loggedIn: false }),
      ]),
    );
    expect(payload.accounts.map((a) => a.status.state)).toEqual(['ready', 'disabled', 'logged-out']);
    expect(payload.accounts[0]?.status.until).toBeNull();
  });

  it('names the active account and what happens next', () => {
    const payload = toStatePayload(
      snapshot([account({ name: 'a' }), account({ name: 'b', active: true })], {
        model: 'fable',
        nextUp: 'staying here, on fable (92% left)',
      }),
    );
    expect(payload.active).toBe('b');
    expect(payload.preferredModel).toBe('fable');
    expect(payload.nextUp).toBe('staying here, on fable (92% left)');
  });

  it('uses null rather than leaving a field out when there is no answer', () => {
    // A reader should never have to tell "absent" from "unknown" for the
    // fields it always looks at.
    const payload = toStatePayload(snapshot([account()]));
    expect(payload.active).toBeNull();
    expect(payload.preferredModel).toBeNull();
    expect(payload.nextUp).toBeNull();
  });

  it('survives an account with no usage read yet', () => {
    // First run, or a probe that has not happened. Unmeasured is not spent.
    const payload = toStatePayload(snapshot([account({ name: 'fresh' })]));
    expect(payload.accounts[0]?.status.state).toBe('ready');
    expect(payload.accounts[0]?.usage).toBeUndefined();
  });
});
