import { describe, it, expect } from 'vitest';
import { bindingUtilization, type UsageLike } from '../usage/headroom.js';
import type { LimitProbeResult } from '../usage/limit-probe.js';
import { MINUTE, type HandPick } from './decide.js';
import {
  inWords,
  runPass,
  type FollowOutcome,
  type PassDeps,
  type PassOptions,
  type SwitchOutcome,
  type WatchAccount,
  type WatchEvent,
} from './pass.js';
import type { UsageRead } from './reads.js';
import { emptyState, type Controls, type WatchState } from './state.js';
import type { TargetCandidate } from './target.js';

const T0 = Date.parse('2030-01-15T12:00:00Z');
const HOUR = 60 * MINUTE;

const windows = (fiveHour: number, sevenDay = 0.3, at = T0): UsageLike => ({
  fiveHour,
  sevenDay,
  fiveHourReset: at + 3 * HOUR,
  sevenDayReset: at + 72 * HOUR,
  models: [],
});

const account = (name: string, over: Partial<WatchAccount> = {}): WatchAccount => ({
  name,
  dir: `/profiles/${name}`,
  priority: 5,
  enabled: true,
  loggedIn: true,
  capped: false,
  ...over,
});

/** A made-up machine: three accounts, `cur` in use for ten minutes. */
function machine() {
  const world = {
    now: T0,
    active: 'cur' as string | null,
    activeSince: T0 - 10 * MINUTE as number | null,
    accounts: [account('cur'), account('b'), account('c')],
    /** What each account's usage really is: a fresh read returns this. */
    real: new Map<string, UsageLike>([
      ['cur', windows(0.5)],
      ['b', windows(0.3)],
      ['c', windows(0.1, 0.1)],
    ]),
    /** What ccx has cached, when it differs from the truth. */
    cached: new Map<string, UsageLike>(),
    /** A read of this account fails this way instead of answering. */
    failing: new Map<string, UsageRead>(),
    /** Accounts whose usage credits carry them past a full window. */
    credits: new Set<string>(),
    expired: new Set<string>(),
    cappedSince: new Map<string, number>(),
    controls: { paused: null, earlyOff: false } as Controls,
    pick: null as HandPick | null,
    switchOutcome: null as SwitchOutcome | null,
    state: emptyState() as WatchState,
    saved: 0,
    reads: [] as string[],
    recorded: [] as string[],
    switches: [] as Array<{ from: string; to: string; reason: string }>,
    logs: [] as string[],
    events: [] as WatchEvent[],
    followed: [] as string[],
    /** How the machines that follow answer, in the order they are asked; the last answer repeats. */
    followAnswers: [[{ host: 'follower', ok: true, detail: 'followed' }]] as FollowOutcome[][],
    picksCleared: 0,
    usageAsked: 0,
  };

  const deps: PassDeps = {
    now: () => world.now,
    accounts: () => world.accounts,
    active: () => world.active,
    activeSince: () => world.activeSince,
    handPick: () => world.pick,
    clearHandPick: () => {
      world.picksCleared += 1;
      world.pick = null;
    },
    cappedSince: (name) => world.cappedSince.get(name) ?? null,
    read: (a, kind) => {
      world.reads.push(`${kind} ${a.name}`);
      const failure = world.failing.get(a.name);
      if (failure) return Promise.resolve(failure);
      const usage = world.real.get(a.name) ?? { fiveHour: null, sevenDay: null };
      const result: LimitProbeResult = { verdict: 'allowed' };
      return Promise.resolve({ ok: true, usage, result, ...(world.credits.has(a.name) ? { creditsCarry: true } : {}) });
    },
    tokenLive: (a) => !world.expired.has(a.name),
    record: (name) => world.recorded.push(name),
    usage: () => {
      world.usageAsked += 1;
      return Promise.resolve(new Map([...world.real, ...world.cached]));
    },
    order: () => (a: TargetCandidate, b: TargetCandidate) =>
      (bindingUtilization(a.usage, undefined, world.now) ?? 1) - (bindingUtilization(b.usage, undefined, world.now) ?? 1) ||
      a.name.localeCompare(b.name),
    switchTo: (from, to, reason) => {
      if (world.switchOutcome) return world.switchOutcome;
      world.switches.push({ from, to, reason });
      world.active = to;
      return { code: 'done', sessions: 2 };
    },
    controls: () => world.controls,
    settings: () => ({ threshold: 0.85, hysteresis: 0.1 }),
    loadState: () => structuredClone(world.state),
    saveState: (state) => {
      world.state = structuredClone(state);
      world.saved += 1;
    },
    log: (line) => world.logs.push(line),
    announce: (event) => {
      world.events.push(event);
      return Promise.resolve();
    },
    follow: (from, to, kind, only) => {
      world.followed.push(`${from}>${to} (${kind})${only ? ` only ${only.join(',')}` : ''}`);
      const answer = world.followAnswers.length > 1 ? world.followAnswers.shift() : world.followAnswers[0];
      return Promise.resolve(answer ?? []);
    },
    random: () => 0.5,
  };

  return {
    world,
    deps,
    pass: (options: Partial<PassOptions> = {}) => runPass(deps, { by: 'service', ...options }),
    /** Move the clock on, and run a pass. */
    after: (ms: number, options: Partial<PassOptions> = {}) => {
      world.now += ms;
      return runPass(deps, { by: 'service', ...options });
    },
    use: (name: string, fiveHour: number, sevenDay = 0.3) => world.real.set(name, windows(fiveHour, sevenDay, world.now)),
  };
}

describe('a pass with room on the account in use', () => {
  it('reads it, files the reading where ccx reads usage, and stays', async () => {
    const m = machine();
    const report = await m.pass();
    expect(report).toMatchObject({ account: 'cur', outcome: 'stayed', read: '5-hour window 50%' });
    expect(report.decision).toMatchObject({ act: false, cat: 'fine' });
    expect(m.world.reads).toEqual(['in-use cur']);
    expect(m.world.recorded).toEqual(['cur']);
    expect(m.world.switches).toEqual([]);
    expect(m.world.logs).toEqual([]);
    expect(m.world.state.reads).toHaveLength(1);
  });

  it('reads once a minute however often it runs', async () => {
    const m = machine();
    await m.pass();
    await m.after(30_000);
    expect(m.world.reads).toHaveLength(1);
    await m.after(30_000);
    expect(m.world.reads).toHaveLength(2);
  });

  it('does not ask ccx about the other accounts while nothing calls for a move', async () => {
    const m = machine();
    await m.pass();
    await m.after(MINUTE);
    expect(m.world.usageAsked).toBe(0);
  });

  it('reads at once when a person asks', async () => {
    const m = machine();
    await m.pass();
    const report = await m.after(10_000, { manual: true, by: 'someone' });
    expect(m.world.reads).toHaveLength(2);
    expect(report.detail).toBe('the account in use has room (50% used); not switching (--force switches anyway)');
  });

  it('counts its reads by hour and status', async () => {
    const m = machine();
    await m.pass();
    expect(m.world.state.counts).toEqual({ '2030-01-15T12': { 'in-use 200': 1 } });
  });
});

describe('a pass with the account in use near its limit', () => {
  it('moves to the account ccx would pick, after reading it fresh, and tells who is listening', async () => {
    const m = machine();
    m.use('cur', 0.9);
    const report = await m.pass();

    expect(report).toMatchObject({ outcome: 'switched', detail: 'moved cur to c' });
    expect(m.world.reads).toEqual(['in-use cur', 'target c']);
    expect(m.world.switches).toEqual([{ from: 'cur', to: 'c', reason: 'early: 90% used' }]);
    expect(m.world.followed).toEqual(['cur>c (early)']);
    expect(m.world.events).toEqual([
      {
        type: 'switched',
        kind: 'early',
        from: 'cur',
        to: 'c',
        by: 'service',
        pickRanOut: false,
        followers: [{ host: 'follower', ok: true, detail: 'followed' }],
      },
    ]);
    expect(m.world.logs).toEqual(['moved cur to c (early: 90% used); 2 running sessions asked to follow']);
  });

  it('starts over on the new account, and leaves its first read 20 to 60 seconds', async () => {
    const m = machine();
    m.use('cur', 0.9);
    await m.pass();

    expect(m.world.state).toMatchObject({
      account: { name: 'c', since: T0 },
      reads: [],
      lastSwitch: { from: 'cur', to: 'c', kind: 'early', by: 'service' },
      holdReadsUntil: T0 + 40_000,
    });
    await m.after(30_000);
    expect(m.world.reads).not.toContain('in-use c');
    await m.after(30_000);
    expect(m.world.reads).toContain('in-use c');
  });

  it('waits out the first two minutes on an account before an early move', async () => {
    const m = machine();
    m.world.activeSince = T0 - MINUTE;
    m.use('cur', 0.9);
    expect(await m.pass()).toMatchObject({ outcome: 'stayed', decision: { cat: 'cooldown' } });
    expect((await m.after(MINUTE)).outcome).toBe('switched');
  });

  it('moves on a fast burn before the threshold is reached', async () => {
    const m = machine();
    m.use('cur', 0.6);
    await m.pass();
    m.use('cur', 0.75);
    const report = await m.after(MINUTE);
    expect(report.outcome).toBe('switched');
    expect(m.world.events[0]).toMatchObject({ kind: 'burn' });
  });

  it('never moves to another profile of the same login', async () => {
    const m = machine();
    m.world.accounts = [
      account('cur', { email: 'Someone@example.com' }),
      account('c', { email: 'someone@example.com' }),
      account('b', { email: 'other@example.com' }),
    ];
    m.use('cur', 0.9);
    await m.pass();
    expect(m.world.switches).toMatchObject([{ to: 'b' }]);
  });
});

describe('a target that is not what the cache says', () => {
  it('is passed over when a fresh read finds it near its limit, and left out for five minutes', async () => {
    const m = machine();
    m.use('cur', 0.9);
    m.world.cached.set('c', windows(0.1, 0.1));
    m.use('c', 0.92);
    const report = await m.pass();

    expect(report.outcome).toBe('switched');
    expect(m.world.reads).toEqual(['in-use cur', 'target c', 'target b']);
    expect(m.world.switches).toMatchObject([{ to: 'b' }]);
    expect(m.world.logs[0]).toBe('c: a fresh read puts it near its limit too; trying the next account');
    expect(m.world.state.full).toEqual({ c: { until: T0 + 5 * MINUTE, loose: false } });
  });

  it('is left out for two hours when its login is refused, and the next one is tried', async () => {
    const m = machine();
    m.use('cur', 0.9);
    m.world.failing.set('c', { ok: false, status: 401 });
    const report = await m.pass();

    expect(report.outcome).toBe('switched');
    expect(m.world.switches).toMatchObject([{ to: 'b' }]);
    expect(m.world.state.failed).toEqual({ c: T0 + 120 * MINUTE });
  });

  it('is taken on ccx\'s number when the read is rate limited rather than answered', async () => {
    const m = machine();
    m.use('cur', 0.9);
    m.world.failing.set('c', { ok: false, status: 429 });
    await m.pass();
    expect(m.world.switches).toMatchObject([{ to: 'c' }]);
  });

  it('is taken on ccx\'s number when its token has expired and cannot be read', async () => {
    const m = machine();
    m.use('cur', 0.9);
    m.world.expired.add('c');
    await m.pass();
    expect(m.world.reads).toEqual(['in-use cur']);
    expect(m.world.switches).toMatchObject([{ to: 'c' }]);
  });
});

describe('a pass with the account in use spent', () => {
  it('confirms on a second reading thirty seconds later, then moves', async () => {
    const m = machine();
    m.use('cur', 1);
    expect(await m.pass()).toMatchObject({ outcome: 'stayed', decision: { cat: 'confirming' } });
    const report = await m.after(30_000);
    expect(report.outcome).toBe('switched');
    expect(m.world.events[0]).toMatchObject({ kind: 'spent' });
  });

  it('takes a target under the looser bar that an early move would refuse', async () => {
    const m = machine();
    m.use('b', 0.88);
    m.use('c', 0.9);
    m.use('cur', 0.9);
    expect((await m.pass()).outcome).toBe('no-room');

    m.use('cur', 1);
    await m.after(MINUTE);
    const report = await m.after(30_000);
    expect(report.outcome).toBe('switched');
    expect(m.world.switches).toMatchObject([{ to: 'b' }]);
  });

  it('goes back to reading once a minute once it is confirmed, however long it stays spent', async () => {
    const m = machine();
    for (const name of ['cur', 'b', 'c']) m.use(name, 1);
    await m.pass();
    await m.after(30_000);
    expect(m.world.reads.filter((r) => r === 'in-use cur')).toHaveLength(2);
    // Nothing has room, so it stays, and the hurry is over.
    for (let i = 0; i < 8; i += 1) await m.after(30_000);
    expect(m.world.reads.filter((r) => r === 'in-use cur')).toHaveLength(6);
  });

  it('is not what an account is while usage credits carry it: it still serves, so a pick holds it', async () => {
    const m = machine();
    m.world.credits.add('cur');
    m.world.pick = { account: 'cur', at: T0 - 5 * MINUTE };
    m.use('cur', 1);
    await m.pass();
    const report = await m.after(MINUTE);
    expect(report).toMatchObject({ outcome: 'held', decision: { kind: 'early' } });
    expect(m.world.switches).toEqual([]);
  });

  it('leaves a credit-carried account like any account near its limit when nobody picked it', async () => {
    const m = machine();
    m.world.credits.add('cur');
    m.use('cur', 1);
    const report = await m.pass();
    expect(report.outcome).toBe('switched');
    expect(m.world.events[0]).toMatchObject({ kind: 'early' });
  });

  it("moves at once when ccx's own ledger already has a refused turn on record", async () => {
    const m = machine();
    m.use('cur', 1);
    m.world.cappedSince.set('cur', T0 - MINUTE);
    expect((await m.pass()).outcome).toBe('switched');
  });
});

describe('what holds a move back', () => {
  it("is a person's own pick, against an early move", async () => {
    const m = machine();
    m.world.pick = { account: 'cur', at: T0 - 5 * MINUTE };
    m.use('cur', 0.9);
    const report = await m.pass();
    expect(report).toMatchObject({ outcome: 'held', detail: 'cur was picked by hand, which holds against an early move' });
    expect(m.world.switches).toEqual([]);
    // Said once, not on every pass while it lasts.
    await m.after(MINUTE);
    expect(m.world.logs).toHaveLength(1);
  });

  it('is not a pick once the picked account is used up: it moves on, says so, and the pick is over', async () => {
    const m = machine();
    m.world.pick = { account: 'cur', at: T0 - 5 * MINUTE };
    m.use('cur', 1);
    await m.pass();
    const report = await m.after(30_000);
    expect(report.outcome).toBe('switched');
    expect(m.world.events[0]).toMatchObject({ kind: 'spent', pickRanOut: true });
    expect(m.world.picksCleared).toBe(1);
  });

  it('is not a pick from an earlier stay on this account, long since moved on from', async () => {
    const m = machine();
    m.world.pick = { account: 'cur', at: T0 - 3 * 24 * HOUR };
    m.use('cur', 0.9);
    expect((await m.pass()).outcome).toBe('switched');
    expect(m.world.events[0]).toMatchObject({ pickRanOut: false });
  });

  it('is not a pick made for another account', async () => {
    const m = machine();
    m.world.pick = { account: 'b', at: T0 - 5 * MINUTE };
    m.use('cur', 0.9);
    expect((await m.pass()).outcome).toBe('switched');
    expect(m.world.picksCleared).toBe(0);
  });

  it('is early moves being off, against an early move only', async () => {
    const m = machine();
    m.world.controls = { paused: null, earlyOff: true };
    m.use('cur', 0.9);
    expect(await m.pass()).toMatchObject({ outcome: 'held', detail: 'early moves are off' });

    m.use('cur', 1);
    await m.after(MINUTE);
    expect((await m.after(30_000)).outcome).toBe('switched');
  });

  it('is a pause, against every move, a spent account and a forced one included', async () => {
    const m = machine();
    m.world.controls = { paused: 'upgrading', earlyOff: false };
    m.use('cur', 1);
    await m.pass();
    expect(await m.after(30_000)).toMatchObject({ outcome: 'held', detail: 'switching is paused (upgrading)' });
    expect(await m.after(MINUTE, { force: true, manual: true })).toMatchObject({ outcome: 'held' });
    expect(m.world.switches).toEqual([]);
    expect(m.world.logs).toEqual([
      'cur: spent (100%), confirming on the next reading',
      'switching is paused (upgrading); would have moved: 100% used',
    ]);
  });
});

describe('when no account has room', () => {
  const full = () => {
    const m = machine();
    m.use('b', 0.9);
    m.use('c', 0.95);
    m.use('cur', 0.9);
    return m;
  };

  it('stays, and says so once per incident', async () => {
    const m = full();
    const report = await m.pass();
    expect(report).toMatchObject({
      outcome: 'no-room',
      detail: 'no account has room (the soonest opens in 3h 0m); staying on cur',
    });
    expect(m.world.events).toEqual([{ type: 'no-room', account: 'cur', until: T0 + 3 * HOUR }]);

    await m.after(MINUTE);
    await m.after(4 * MINUTE);
    expect(m.world.events).toHaveLength(1);
  });

  it('does not ask ccx about every account again for three minutes', async () => {
    const m = full();
    await m.pass();
    await m.after(MINUTE);
    await m.after(MINUTE);
    expect(m.world.usageAsked).toBe(1);
    await m.after(2 * MINUTE);
    expect(m.world.usageAsked).toBe(2);
  });

  it('looks again at once when the account goes from near its limit to spent', async () => {
    const m = full();
    m.use('b', 0.88);
    await m.pass();
    expect(m.world.usageAsked).toBe(1);

    m.use('cur', 1);
    await m.after(MINUTE);
    await m.after(30_000);
    expect(m.world.switches).toMatchObject([{ to: 'b' }]);
  });

  it('forgets the incident once the account in use has room again', async () => {
    const m = full();
    await m.pass();
    m.use('cur', 0.4);
    await m.after(MINUTE);
    expect(m.world.state.none).toBeNull();
  });

  it("stays without calling it an incident when only one model's own week is spent here", async () => {
    const m = machine();
    const fableGone = (fiveHour: number): UsageLike => ({
      ...windows(fiveHour),
      models: [{ name: 'Fable', utilization: 1, resetsAt: T0 + 48 * HOUR }],
    });
    for (const name of ['cur', 'b', 'c']) m.world.real.set(name, fableGone(0.3));
    await m.pass();
    const report = await m.after(30_000);
    expect(report).toMatchObject({
      outcome: 'stayed',
      detail: "only one model's own week is spent and no account is roomier; staying",
    });
    expect(m.world.events).toEqual([]);
    expect(m.world.switches).toEqual([]);
  });
});

describe("settling for an account with one model's week spent", () => {
  const fableAt = (fiveHour: number, fable: number): UsageLike => ({
    ...windows(fiveHour),
    models: [{ name: 'Fable', utilization: fable, resetsAt: T0 + 48 * HOUR }],
  });

  it('never happens on an early move, while the account in use still serves every model', async () => {
    const m = machine();
    m.world.real.set('cur', fableAt(0.86, 0.5));
    m.world.real.set('b', fableAt(0.4, 1));
    m.world.real.set('c', fableAt(0.3, 1));
    const report = await m.pass();
    expect(report.outcome).toBe('no-room');
    expect(m.world.switches).toEqual([]);
  });

  it('happens once nothing runs on the account in use at all', async () => {
    const m = machine();
    m.world.real.set('cur', fableAt(1, 0.5));
    m.world.real.set('b', fableAt(0.4, 1));
    m.world.real.set('c', fableAt(0.9, 1));
    await m.pass();
    const report = await m.after(30_000);
    expect(report.outcome).toBe('switched');
    expect(m.world.switches).toMatchObject([{ to: 'b' }]);
    expect(m.world.logs.at(-1)).toContain("one model's own week is spent there");
  });
});

describe('deciding by one model', () => {
  const fable = (fiveHour: number, used: number): UsageLike => ({
    ...windows(fiveHour),
    models: [{ name: 'Fable', utilization: used, resetsAt: T0 + 48 * HOUR }],
  });

  it("counts every model's own week unless told which one matters", async () => {
    const m = machine();
    m.world.real.set('cur', fable(0.3, 0.9));
    expect((await m.pass()).outcome).toBe('switched');
  });

  it("leaves another model's week out of it, here and on the target", async () => {
    const m = machine();
    m.deps.settings = () => ({ threshold: 0.85, hysteresis: 0.1, model: 'opus' });
    m.world.real.set('cur', fable(0.3, 0.9));
    expect(await m.pass()).toMatchObject({ outcome: 'stayed', read: '5-hour window 30%' });

    // The only account with room has its Fable week spent, which is no bar to Opus.
    m.world.real.set('cur', fable(0.9, 0.2));
    m.world.real.set('c', fable(0.1, 1));
    m.use('b', 0.9);
    await m.after(MINUTE);
    expect(m.world.switches).toMatchObject([{ to: 'c' }]);
  });

  it('counts the week of the model it was told', async () => {
    const m = machine();
    m.deps.settings = () => ({ threshold: 0.85, hysteresis: 0.1, model: 'fable' });
    m.world.real.set('cur', fable(0.3, 0.9));
    const report = await m.pass();
    expect(report.outcome).toBe('switched');
    expect(report.read).toBe('Fable week 90%');
  });
});

describe('a switch that does not go through', () => {
  it('is left for the next pass when another switch holds the lock', async () => {
    const m = machine();
    m.use('cur', 0.9);
    m.world.switchOutcome = { code: 'busy' };
    expect(await m.pass()).toMatchObject({ outcome: 'busy' });
    expect(m.world.state.account).toMatchObject({ name: 'cur' });
    expect(m.world.events).toEqual([]);
  });

  it('is dropped when somebody switched first', async () => {
    const m = machine();
    m.use('cur', 0.9);
    m.world.switchOutcome = { code: 'changed', active: 'b' };
    const report = await m.pass();
    expect(report).toMatchObject({ outcome: 'stayed', detail: 'the account in use changed to b first; judging it on the next pass' });
    expect(m.world.events).toEqual([]);
  });

  it('leaves the target out for two hours when the switch itself failed', async () => {
    const m = machine();
    m.use('cur', 0.9);
    m.world.switchOutcome = { code: 'failed', why: 'no account "c"' };
    expect(await m.pass()).toMatchObject({ outcome: 'failed', detail: 'no account "c"' });
    expect(m.world.state.failed).toEqual({ c: T0 + 120 * MINUTE });
  });
});

describe('an account changed by someone else', () => {
  it('is read at once, and judged from nothing', async () => {
    const m = machine();
    m.use('cur', 0.8);
    await m.pass();
    m.world.active = 'b';
    m.world.activeSince = T0 + 10_000;
    const report = await m.after(20_000);

    expect(report).toMatchObject({ account: 'b', outcome: 'stayed' });
    expect(m.world.reads).toEqual(['in-use cur', 'in-use b']);
    expect(m.world.logs).toEqual(['the account in use is now b (was cur)']);
    expect(m.world.state).toMatchObject({ account: { name: 'b', since: T0 + 10_000 } });
    expect(m.world.state.reads).toHaveLength(1);
  });
});

describe('reads that fail', () => {
  it('back off as long as the endpoint asks, and no longer than a minute when the last reading was high', async () => {
    const m = machine();
    m.use('cur', 0.8);
    await m.pass();
    m.world.failing.set('cur', { ok: false, status: 429, retryAfterMs: 10 * MINUTE });
    const report = await m.after(MINUTE);
    expect(report.read).toBe('usage read failed (429)');
    expect(m.world.state.holdReadsUntil).toBe(m.world.now + MINUTE);
  });

  it('back off up to five minutes when there was room', async () => {
    const m = machine();
    await m.pass();
    m.world.failing.set('cur', { ok: false, status: 429, retryAfterMs: 10 * MINUTE });
    await m.after(MINUTE);
    expect(m.world.state.holdReadsUntil).toBe(m.world.now + 5 * MINUTE);
  });

  it('count as near the limit when the last answer was already high', async () => {
    const m = machine();
    m.use('cur', 0.82);
    await m.pass();
    m.world.failing.set('cur', { ok: false, status: 429 });
    await m.after(MINUTE);
    const report = await m.after(MINUTE);
    expect(report.outcome).toBe('switched');
    expect(m.world.events[0]).toMatchObject({ kind: 'blind-high' });
  });

  it('move off a login refused twice on a token that has not expired', async () => {
    const m = machine();
    m.world.failing.set('cur', { ok: false, status: 401 });
    expect((await m.pass()).outcome).toBe('stayed');
    const report = await m.after(30_000);
    expect(report.outcome).toBe('switched');
    expect(m.world.events[0]).toMatchObject({ kind: 'dead' });
    // Refused, so nothing is known of it: the looser bar applies.
    expect(m.world.state.lastSwitch).toMatchObject({ kind: 'dead' });
  });

  it('move off a refused login once per half hour, whatever other moves happened in between', async () => {
    const m = machine();
    m.world.failing.set('cur', { ok: false, status: 401 });
    await m.pass();
    await m.after(30_000);
    expect(m.world.switches).toMatchObject([{ from: 'cur', to: 'c' }]);

    // An ordinary early move, a few minutes later.
    m.use('c', 0.9);
    await m.after(5 * MINUTE);
    expect(m.world.switches).toMatchObject([{ to: 'c' }, { from: 'c', to: 'b' }]);

    // Then the login in use is refused again, inside the half hour.
    m.world.failing.set('b', { ok: false, status: 401 });
    await m.after(3 * MINUTE);
    const held = await m.after(30_000);
    expect(held).toMatchObject({ outcome: 'stayed', decision: { cat: 'held' } });
    expect(m.world.switches).toHaveLength(2);
  });

  it('do not count a refusal against a token that has simply expired', async () => {
    const m = machine();
    m.world.failing.set('cur', { ok: false, status: 401 });
    m.world.expired.add('cur');
    await m.pass();
    await m.after(MINUTE);
    await m.after(MINUTE);
    expect(m.world.state.refusals).toBeNull();
    expect(m.world.switches).toEqual([]);
  });

  it('stay put when it is the network and nothing was high', async () => {
    const m = machine();
    await m.pass();
    m.world.failing.set('cur', { ok: false, status: 'network' });
    for (let i = 0; i < 6; i += 1) await m.after(MINUTE);
    expect(m.world.switches).toEqual([]);
  });
});

describe('a pass a person asked for', () => {
  it('moves when forced, to the best account under the limit even when it is no roomier', async () => {
    const m = machine();
    m.use('cur', 0.05);
    const report = await m.pass({ force: true, manual: true, by: 'someone' });
    expect(report.outcome).toBe('switched');
    expect(m.world.switches).toEqual([{ from: 'cur', to: 'c', reason: 'forced: asked by someone' }]);
    expect(m.world.events[0]).toMatchObject({ kind: 'forced', by: 'someone', pickRanOut: false });
  });

  it('says what it would do in a dry run, and does none of it', async () => {
    const m = machine();
    m.use('cur', 0.9);
    const report = await m.pass({ dryRun: true });
    expect(report).toMatchObject({ outcome: 'would-switch', detail: 'would move cur to c (early: 90% used)' });
    expect(m.world.switches).toEqual([]);
    expect(m.world.events).toEqual([]);
    expect(m.world.recorded).toEqual([]);
    expect(m.world.saved).toBe(0);
  });

  it('writes no line to the history in a dry run, whatever it finds on the way', async () => {
    const m = machine();
    m.use('cur', 0.9);
    // The first target turns out full, which a real pass would log.
    m.world.cached.set('c', windows(0.1, 0.1));
    m.use('c', 0.92);
    await m.pass({ dryRun: true });
    m.world.controls = { paused: 'upgrading', earlyOff: false };
    await m.pass({ dryRun: true });
    expect(m.world.logs).toEqual([]);
  });

  it('looks for room again when forced, even right after nothing had any', async () => {
    const m = machine();
    m.use('b', 0.9);
    m.use('c', 0.95);
    m.use('cur', 0.9);
    expect((await m.pass()).outcome).toBe('no-room');
    m.use('c', 0.2);
    // A minute on, an ordinary pass still waits out the three minutes.
    expect(await m.after(MINUTE)).toMatchObject({ outcome: 'no-room', detail: 'no account had room under three minutes ago' });
    expect((await m.pass({ force: true })).outcome).toBe('switched');
  });
});

describe('a pass with nothing to watch', () => {
  it('is idle when no account is active', async () => {
    const m = machine();
    m.world.active = null;
    expect(await m.pass()).toMatchObject({ account: null, outcome: 'idle', detail: 'no account is active' });
    expect(m.world.reads).toEqual([]);
  });

  it('is idle when the active account is no longer registered', async () => {
    const m = machine();
    m.world.active = 'gone';
    expect(await m.pass()).toMatchObject({ outcome: 'idle', detail: 'the active account "gone" is not registered' });
  });
});

describe('telling and following', () => {
  it('never fail a pass: the switch is made whatever becomes of the message', async () => {
    const m = machine();
    m.use('cur', 0.9);
    m.deps.announce = () => Promise.reject(new Error('the webhook is down'));
    m.deps.follow = () => Promise.reject(new Error('no route to host'));
    const report = await m.pass();
    expect(report.outcome).toBe('switched');
    expect(m.world.state.account).toMatchObject({ name: 'c' });
  });
});

describe('a machine that could not be asked to follow', () => {
  const asleep: FollowOutcome = { host: 'laptop', ok: false, detail: 'could not reach it', retry: true };
  const switched = async () => {
    const m = machine();
    m.use('cur', 0.9);
    m.world.followAnswers = [[asleep, { host: 'desk', ok: true, detail: 'now on c' }], [asleep], [{ host: 'laptop', ok: true, detail: 'now on c' }]];
    await m.pass();
    return m;
  };

  it('is asked again a minute later, alone, and the asking stops once it follows', async () => {
    const m = await switched();
    expect(m.world.followed).toEqual(['cur>c (early)']);
    expect(m.world.state.follow).toMatchObject({ from: 'cur', to: 'c', kind: 'early', hosts: ['laptop'] });

    await m.after(30_000);
    expect(m.world.followed).toHaveLength(1);
    await m.after(30_000);
    expect(m.world.followed[1]).toBe('cur>c (early) only laptop');
    expect(m.world.state.follow).toMatchObject({ hosts: ['laptop'] });

    await m.after(MINUTE);
    expect(m.world.logs.at(-1)).toBe('laptop followed, late: now on c');
    expect(m.world.state.follow).toBeNull();
    await m.after(MINUTE);
    expect(m.world.followed).toHaveLength(3);
  });

  it('is given up on after ten minutes', async () => {
    const m = await switched();
    m.world.followAnswers = [[asleep]];
    for (let minute = 0; minute < 12; minute += 1) await m.after(MINUTE);
    expect(m.world.state.follow).toBeNull();
    // The first ask, then one a minute while the ten minutes last.
    expect(m.world.followed.length).toBeLessThanOrEqual(11);
    const asks = m.world.followed.length;
    await m.after(MINUTE);
    expect(m.world.followed).toHaveLength(asks);
  });

  it('is not asked to make a move that a newer switch has overtaken', async () => {
    const m = await switched();
    m.world.active = 'b';
    m.world.activeSince = m.world.now + 10_000;
    await m.after(MINUTE);
    expect(m.world.followed).toHaveLength(1);
    expect(m.world.state.follow).toBeNull();
  });

  it('is not put down for a retry when its answer was final', async () => {
    const m = machine();
    m.use('cur', 0.9);
    m.world.followAnswers = [[{ host: 'laptop', ok: false, detail: 'on side, not cur; left as it is' }]];
    await m.pass();
    expect(m.world.state.follow).toBeNull();
  });
});

describe('a wait in words', () => {
  it('reads as minutes, then hours, then days', () => {
    expect(inWords(20_000)).toBe('in 1 min');
    expect(inWords(25 * MINUTE)).toBe('in 25 min');
    expect(inWords(3 * HOUR + 10 * MINUTE)).toBe('in 3h 10m');
    expect(inWords(52 * HOUR)).toBe('in 2d 4h');
  });
});
