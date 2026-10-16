import { describe, it, expect } from 'vitest';
import { bindingUtilization, type UsageLike } from '../usage/headroom.js';
import { MINUTE } from './decide.js';
import { pickTarget, wideUtilization, type PickInput, type TargetCandidate } from './target.js';

const now = Date.parse('2030-01-15T12:00:00Z');
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const usage = (fiveHour: number | null, sevenDay: number | null = 0.3, fiveHourReset = now + 3 * HOUR): UsageLike => ({
  fiveHour,
  sevenDay,
  fiveHourReset,
  sevenDayReset: now + 3 * DAY,
  models: [],
});
const withFable = (fiveHour: number, fable: number): UsageLike => ({
  ...usage(fiveHour),
  models: [{ name: 'Fable', utilization: fable, resetsAt: now + 2 * DAY }],
});
const account = (name: string, u: UsageLike | null, over: Partial<TargetCandidate> = {}): TargetCandidate => ({
  name,
  priority: 5,
  enabled: true,
  loggedIn: true,
  capped: false,
  usage: u,
  ...over,
});

/** Most room first, as the `most-room` order sorts; then by name. */
const mostRoom = (a: TargetCandidate, b: TargetCandidate): number =>
  (bindingUtilization(a.usage, undefined, now) ?? 1) - (bindingUtilization(b.usage, undefined, now) ?? 1) ||
  a.name.localeCompare(b.name);

const pick = (candidates: TargetCandidate[], over: Partial<PickInput> = {}) =>
  pickTarget({
    current: 'cur',
    candidates,
    currentUsed: 1,
    currentWide: 1,
    skipUntil: {},
    sameLogin: [],
    limit: 0.85,
    hysteresis: 0.1,
    otherModels: true,
    order: mostRoom,
    now,
    ...over,
  });

const fleet = [
  account('cur', usage(1)),
  account('b', usage(0.3)),
  account('c', usage(0.1, 0.1)),
  account('capped', usage(0), { capped: true }),
  account('off', usage(0), { enabled: false }),
  account('signed-out', usage(0), { loggedIn: false }),
  account('unread', { fiveHour: null, sevenDay: null }),
  account('high', usage(0.88)),
];

describe('picking where to go', () => {
  it('takes the first fitting account in the order ccx is set to pick by', () => {
    expect(pick(fleet)).toMatchObject({ name: 'c', how: 'room' });
    const byName = (a: TargetCandidate, b: TargetCandidate): number => a.name.localeCompare(b.name);
    expect(pick(fleet, { order: byName })).toMatchObject({ name: 'b' });
  });

  it('never picks an account that is capped, disabled, signed out or unread', () => {
    const none = fleet.filter((a) => !['b', 'c', 'high'].includes(a.name));
    expect(pick(none)).toMatchObject({ name: null });
  });

  it('leaves out an account that failed a move, until its time is up', () => {
    expect(pick(fleet, { skipUntil: { c: now + MINUTE } })).toMatchObject({ name: 'b' });
    expect(pick(fleet, { skipUntil: { c: now - MINUTE } })).toMatchObject({ name: 'c' });
  });

  it('never moves to another profile of the login in use', () => {
    const twins = [account('cur', usage(1)), account('twin', usage(0, 0.1)), account('b', usage(0.3))];
    expect(pick(twins, { sameLogin: ['cur', 'twin'] })).toMatchObject({ name: 'b' });
  });

  it('needs the target meaningfully roomier, so an early move does not bounce', () => {
    expect(pick([account('cur', usage(0.96)), account('high', usage(0.88))], { currentUsed: 0.96, currentWide: 0.96 }))
      .toMatchObject({ name: null });
    expect(pick([account('cur', usage(0.9)), account('h', usage(0.88))], { currentUsed: 0.9, currentWide: 0.9 }))
      .toMatchObject({ name: null });
  });

  it('counts a spent week even beside a fresh 5-hour window', () => {
    expect(pick([account('cur', usage(1)), account('week-gone', usage(0, 0.97))])).toMatchObject({ name: null });
  });
});

describe('with the account in use spent', () => {
  const spent = (candidates: TargetCandidate[]) => pick(candidates, { limit: 0.95, hysteresis: 0.05 });

  it('takes a target under the looser bar rather than leave every session stopped', () => {
    expect(spent([account('cur', usage(1)), account('h', usage(0.88))])).toMatchObject({ name: 'h', how: 'room' });
    expect(spent([account('cur', usage(1)), account('h1', usage(0.93)), account('h2', usage(0.87))])).toMatchObject({
      name: 'h2',
    });
  });

  it('still never takes one at the bar itself', () => {
    expect(spent([account('cur', usage(1)), account('h', usage(0.96))])).toMatchObject({ name: null });
  });
});

describe('when nothing has room', () => {
  it('says when the soonest spent account opens again', () => {
    const all = [
      account('cur', usage(1, 0.3, now + 50 * MINUTE)),
      account('x', usage(1, 0.3, now + 97 * MINUTE)),
      account('y', usage(0.99, 0.3, now + 30 * MINUTE)),
    ];
    expect(pick(all)).toEqual({ name: null, until: now + 30 * MINUTE });
  });

  it('waits for the last of an account\'s spent windows, not the first', () => {
    const both: UsageLike = { ...usage(1, 1, now + 20 * MINUTE), sevenDayReset: now + 2 * DAY };
    expect(pick([account('cur', both)])).toEqual({ name: null, until: now + 2 * DAY });
  });

  it('gives no time when no reset is known', () => {
    expect(pick([account('cur', { fiveHour: 1, sevenDay: null })])).toEqual({ name: null, until: null });
  });
});

describe("one model's own week", () => {
  it('is left out when the account in use is spent for every model and the others are only out of that one', () => {
    const picked = pick([account('cur', withFable(1, 0.2)), account('fable-gone', withFable(0.1, 1))]);
    expect(picked).toMatchObject({ name: 'fable-gone', how: 'other-models' });
  });

  it('never rescues an account ccx has down as refused', () => {
    const picked = pick([account('cur', withFable(1, 0.2)), account('refused', withFable(0.1, 1), { capped: true })]);
    expect(picked).toMatchObject({ name: null });
  });

  it('is no reason to move while every other model still runs here', () => {
    const candidates = [account('cur', withFable(0.3, 1)), account('fable-gone', withFable(0.1, 1))];
    expect(pick(candidates, { currentWide: 0.3, otherModels: false })).toMatchObject({ name: null });
  });

  it('is never left out for an early move: the account in use still serves every model', () => {
    // Near its limit, not at it. Moving everything onto an account where a
    // model is gone would trade working sessions for refused turns.
    const candidates = [account('cur', withFable(0.86, 0.5)), account('fable-gone', withFable(0.4, 1))];
    expect(pick(candidates, { currentUsed: 0.86, currentWide: 0.86, otherModels: false })).toMatchObject({ name: null });
    expect(pick(candidates, { currentUsed: 0.86, currentWide: 0.86, otherModels: true })).toMatchObject({
      name: 'fable-gone',
      how: 'other-models',
    });
  });

  it('moves for that model when another account has room on it', () => {
    const candidates = [account('cur', withFable(0.3, 1)), account('ok', withFable(0.1, 0.2))];
    expect(pick(candidates, { currentWide: 0.3, otherModels: false })).toMatchObject({ name: 'ok', how: 'room' });
  });
});

describe('usage without the per-model weeks', () => {
  it('reads the account-wide windows alone', () => {
    expect(wideUtilization(withFable(0.2, 0.97), now)).toBe(0.3);
    expect(wideUtilization(null, now)).toBeNull();
  });
});
