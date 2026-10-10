import { describe, it, expect } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHopController, type HopDeps } from './hop.js';
import { hopDir, markDone, openHops, readState, writeAsk, type HopAsk } from './hop-files.js';

interface Acct {
  name: string;
}

const WORK: Acct = { name: 'work' };
const HOME: Acct = { name: 'home' };
const OTHER: Acct = { name: 'other' };

/** A session folder, a clock the test moves, and a session that starts on "work". */
function setup(over: Partial<HopDeps<Acct>> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-hop-'));
  openHops(dir, 1234);
  const world = {
    dir,
    now: 10_000,
    on: WORK as Acct | null,
    accounts: [WORK, HOME, OTHER] as Acct[],
    moves: [] as string[],
    logged: [] as Array<{ message: string; data: Record<string, unknown> }>,
  };
  const deps: HopDeps<Acct> = {
    dir,
    now: () => world.now,
    current: () => world.on,
    account: (name) => world.accounts.find((a) => a.name === name) ?? null,
    readiness: () => 'ready',
    renew: () => Promise.resolve({ ok: true }),
    activate: (account) => {
      world.moves.push(account.name);
      world.on = account;
    },
    standing: () => 'free',
    log: (message, data) => world.logged.push({ message, data }),
    holdMs: 60_000,
    ...over,
  };
  const ask = (id: string, to: string, more: Partial<HopAsk> = {}): void =>
    writeAsk(dir, { id, to, at: world.now, transcript: null, transcriptFrom: null, ...more });
  return { world, hop: createHopController(deps), ask };
}

describe('a temporary move for one Artifact call', () => {
  it('does nothing while nobody asks', () => {
    const { world, hop } = setup();
    expect(hop.poll()).toBe(false);
    hop.tick();
    expect(world.moves).toEqual([]);
    expect(hop.away()).toBeNull();
  });

  it('puts the session on the account asked for, and says so to whoever asked', () => {
    const { world, hop, ask } = setup();
    ask('toolu_1', 'home');
    expect(hop.poll()).toBe(true);
    expect(world.moves).toEqual(['home']);
    expect(readState(world.dir, 'toolu_1')).toEqual({
      id: 'toolu_1',
      state: 'applied',
      to: 'home',
      from: 'work',
      at: 10_000,
      moved: true,
    });
    expect(hop.away()).toEqual({ from: WORK, to: HOME });
  });

  it('puts it straight back when the call is reported over', () => {
    const { world, hop, ask } = setup();
    ask('toolu_1', 'home');
    hop.poll();
    world.now += 1_300;
    markDone(world.dir, 'toolu_1');
    hop.tick();
    expect(world.moves).toEqual(['home', 'work']);
    expect(hop.away()).toBeNull();
    expect(readState(world.dir, 'toolu_1')).toEqual({
      id: 'toolu_1',
      state: 'ended',
      to: 'home',
      from: 'work',
      at: 10_000,
      endedAt: 11_300,
      by: 'done',
    });
    // The request and the mark are gone; only the answer stays, for the hook that reads it.
    expect(readdirSync(hopDir(world.dir)).sort()).toEqual(['ready.json', 'toolu_1.hop.json']);
  });

  it('goes back by its own clock when nothing ever reports the call over', () => {
    const { world, hop, ask } = setup();
    ask('toolu_1', 'home');
    hop.poll();
    world.now += 59_999;
    hop.tick();
    expect(world.moves).toEqual(['home']);
    expect(hop.away()).not.toBeNull();
    world.now += 1;
    hop.tick();
    expect(world.moves).toEqual(['home', 'work']);
    expect(readState(world.dir, 'toolu_1')).toMatchObject({ state: 'ended', by: 'deadline' });
    expect(hop.away()).toBeNull();
  });

  it('goes back when the call’s result turns up in the conversation’s record, hook or no hook', () => {
    const { world, hop, ask } = setup();
    const transcript = path.join(world.dir, 'conversation.jsonl');
    writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1' }] } })}\n`);
    ask('toolu_1', 'home', { transcript, transcriptFrom: 0 });
    hop.poll();
    hop.tick();
    expect(hop.away()).not.toBeNull();
    // Somebody else's result is not this call's.
    appendFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2' }] } })}\n`);
    hop.tick();
    expect(hop.away()).not.toBeNull();
    // A refusal by the person, a failure and a success are all written this way.
    appendFileSync(
      transcript,
      `${JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: 'toolu_1', type: 'tool_result', is_error: true }] } })}\n`,
    );
    hop.tick();
    expect(world.moves).toEqual(['home', 'work']);
    expect(readState(world.dir, 'toolu_1')).toMatchObject({ state: 'ended', by: 'result' });
  });

  it('goes back at once when Claude itself ends', () => {
    const { world, hop, ask } = setup();
    ask('toolu_1', 'home');
    hop.poll();
    hop.childEnded();
    expect(world.moves).toEqual(['home', 'work']);
    expect(readState(world.dir, 'toolu_1')).toMatchObject({ state: 'ended', by: 'child-exit' });
    expect(hop.away()).toBeNull();
  });

  it('keeps trying to go back when going back fails, and never forgets it is away', () => {
    let failing = true;
    const { world, hop, ask } = setup();
    const moved: string[] = [];
    const flaky = createHopController<Acct>({
      dir: world.dir,
      now: () => world.now,
      current: () => world.on,
      account: (name) => world.accounts.find((a) => a.name === name) ?? null,
      readiness: () => 'ready',
      renew: () => Promise.resolve({ ok: true }),
      activate: (account) => {
        if (account.name === 'work' && failing) throw new Error('the login is locked');
        moved.push(account.name);
        world.on = account;
      },
      standing: () => 'free',
      log: (message, data) => world.logged.push({ message, data }),
      holdMs: 60_000,
    });
    void hop;
    ask('toolu_1', 'home');
    flaky.poll();
    markDone(world.dir, 'toolu_1');
    flaky.tick();
    flaky.tick();
    expect(moved).toEqual(['home']);
    expect(flaky.away()).toEqual({ from: WORK, to: HOME });
    expect(readState(world.dir, 'toolu_1')?.state).toBe('applied');
    // Said once, not on every try.
    expect(world.logged.filter((l) => l.message.includes('could not'))).toHaveLength(1);
    failing = false;
    flaky.tick();
    expect(moved).toEqual(['home', 'work']);
    expect(flaky.away()).toBeNull();
  });

  it('goes back to the account it left even after that account was removed from the list', () => {
    const { world, hop, ask } = setup();
    ask('toolu_1', 'home');
    hop.poll();
    world.accounts = [HOME, OTHER];
    markDone(world.dir, 'toolu_1');
    hop.tick();
    expect(world.moves).toEqual(['home', 'work']);
  });

  it('does not drag the session back when something else moved it meanwhile', () => {
    const { world, hop, ask } = setup();
    ask('toolu_1', 'home');
    hop.poll();
    world.on = OTHER;
    markDone(world.dir, 'toolu_1');
    hop.tick();
    expect(world.moves).toEqual(['home']);
    expect(world.on).toBe(OTHER);
    expect(hop.away()).toBeNull();
    expect(readState(world.dir, 'toolu_1')).toMatchObject({ state: 'ended' });
  });
});

describe('a request that cannot be honoured', () => {
  it('is refused for an account that does not exist, and the session stays where it is', () => {
    const { world, hop, ask } = setup();
    ask('toolu_1', 'nobody');
    expect(hop.poll()).toBe(false);
    expect(world.moves).toEqual([]);
    const state = readState(world.dir, 'toolu_1');
    expect(state?.state).toBe('refused');
    expect(state?.state === 'refused' && state.reason).toContain('"nobody"');
    expect(existsSync(path.join(hopDir(world.dir), 'toolu_1.ask.json'))).toBe(false);
  });

  it('is refused for an account with no login, naming the command that signs it in', () => {
    const { world, hop, ask } = setup({ readiness: () => 'no-login' });
    ask('toolu_1', 'home');
    hop.poll();
    expect(world.moves).toEqual([]);
    const state = readState(world.dir, 'toolu_1');
    expect(state?.state === 'refused' && state.reason).toContain('ccx login home');
  });

  it('is refused, with the reason, in a session that cannot be moved in place at all', () => {
    const { world, hop, ask } = setup({ standing: () => ({ refuse: 'this session runs on a long-lived token' }) });
    ask('toolu_1', 'home');
    hop.poll();
    expect(world.moves).toEqual([]);
    const state = readState(world.dir, 'toolu_1');
    expect(state?.state === 'refused' && state.reason).toContain('long-lived token');
  });

  it('is refused when the move itself fails, and the session is not left reported as away', () => {
    const { world, hop, ask } = setup({
      activate: () => {
        throw new Error('the login is locked');
      },
    });
    ask('toolu_1', 'home');
    expect(hop.poll()).toBe(false);
    expect(hop.away()).toBeNull();
    const state = readState(world.dir, 'toolu_1');
    expect(state?.state === 'refused' && state.reason).toContain('the login is locked');
  });

  it('waits, unanswered, while a usage limit is being decided, and is taken up after', () => {
    let standing: 'free' | 'busy' = 'busy';
    const { world, hop, ask } = setup({ standing: () => standing });
    ask('toolu_1', 'home');
    expect(hop.poll()).toBe(false);
    expect(world.moves).toEqual([]);
    expect(readState(world.dir, 'toolu_1')).toBeNull();
    standing = 'free';
    expect(hop.poll()).toBe(true);
    expect(world.moves).toEqual(['home']);
  });

  it('is dropped when whoever asked gave up before it was answered', () => {
    const { world, hop, ask } = setup();
    ask('toolu_1', 'home');
    markDone(world.dir, 'toolu_1');
    expect(hop.poll()).toBe(false);
    expect(world.moves).toEqual([]);
    expect(readdirSync(hopDir(world.dir))).toEqual(['ready.json']);
  });

  it('is dropped when it is older than any hook would still be waiting for', () => {
    const { world, hop, ask } = setup({ askTtlMs: 30_000 });
    ask('toolu_1', 'home');
    world.now += 30_001;
    expect(hop.poll()).toBe(false);
    expect(world.moves).toEqual([]);
    expect(readdirSync(hopDir(world.dir))).toEqual(['ready.json']);
  });

  it('needs no move, and holds nothing, when the session is already on that account', () => {
    const { world, hop, ask } = setup();
    ask('toolu_1', 'work');
    expect(hop.poll()).toBe(false);
    expect(world.moves).toEqual([]);
    expect(readState(world.dir, 'toolu_1')).toMatchObject({ state: 'applied', moved: false, from: 'work', to: 'work' });
    expect(hop.away()).toBeNull();
  });
});

describe('a login that is due for renewal', () => {
  it('is renewed first, and the session is only moved once that worked', async () => {
    let finish: (result: { ok: true } | { ok: false; reason: string }) => void = () => {};
    const renewed: string[] = [];
    const { world, hop, ask } = setup({
      readiness: (account) => (renewed.includes(account.name) ? 'ready' : 'renewal-due'),
      renew: (account) =>
        new Promise((resolve) => {
          finish = (result) => {
            if (result.ok) renewed.push(account.name);
            resolve(result);
          };
        }),
    });
    ask('toolu_1', 'home');
    // Being prepared: other moves wait, and nothing has moved yet.
    expect(hop.poll()).toBe(true);
    expect(hop.poll()).toBe(true);
    expect(world.moves).toEqual([]);
    expect(readState(world.dir, 'toolu_1')).toBeNull();
    finish({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(hop.poll()).toBe(true);
    expect(world.moves).toEqual(['home']);
    expect(readState(world.dir, 'toolu_1')).toMatchObject({ state: 'applied', moved: true });
  });

  it('is refused with the reason when it cannot be renewed, and the session never moves', async () => {
    const { world, hop, ask } = setup({
      readiness: () => 'renewal-due',
      renew: () => Promise.resolve({ ok: false, reason: 'another session is using "home"' }),
    });
    ask('toolu_1', 'home');
    hop.poll();
    await Promise.resolve();
    await Promise.resolve();
    expect(hop.poll()).toBe(false);
    expect(world.moves).toEqual([]);
    const state = readState(world.dir, 'toolu_1');
    expect(state?.state === 'refused' && state.reason).toContain('another session is using "home"');
  });

  it('is refused when the renewal throws', async () => {
    const { world, hop, ask } = setup({
      readiness: () => 'renewal-due',
      renew: () => Promise.reject(new Error('offline')),
    });
    ask('toolu_1', 'home');
    hop.poll();
    await Promise.resolve();
    await Promise.resolve();
    hop.poll();
    expect(world.moves).toEqual([]);
    expect(readState(world.dir, 'toolu_1')?.state).toBe('refused');
  });

  it('moves nothing when Claude ended while the login was being renewed', async () => {
    let finish: () => void = () => {};
    const { world, hop, ask } = setup({
      readiness: () => 'renewal-due',
      renew: () => new Promise((resolve) => (finish = () => resolve({ ok: true }))),
    });
    ask('toolu_1', 'home');
    hop.poll();
    hop.childEnded();
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(hop.poll()).toBe(false);
    expect(world.moves).toEqual([]);
  });

  it('moves nothing when whoever asked gave up while the login was being renewed', async () => {
    let finish: () => void = () => {};
    const { world, hop, ask } = setup({
      readiness: () => 'renewal-due',
      renew: () => new Promise((resolve) => (finish = () => resolve({ ok: true }))),
    });
    ask('toolu_1', 'home');
    hop.poll();
    markDone(world.dir, 'toolu_1');
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(hop.poll()).toBe(false);
    expect(world.moves).toEqual([]);
  });
});

describe('several calls at once', () => {
  it('are served one at a time, the oldest first, each back home before the next leaves', () => {
    const { world, hop, ask } = setup();
    ask('toolu_1', 'home');
    world.now += 5;
    ask('toolu_2', 'other');
    expect(hop.poll()).toBe(true);
    expect(hop.poll()).toBe(true);
    expect(world.moves).toEqual(['home']);
    expect(readState(world.dir, 'toolu_2')).toBeNull();
    markDone(world.dir, 'toolu_1');
    hop.tick();
    expect(world.moves).toEqual(['home', 'work']);
    expect(hop.poll()).toBe(true);
    expect(world.moves).toEqual(['home', 'work', 'other']);
    expect(readState(world.dir, 'toolu_2')).toMatchObject({ state: 'applied', from: 'work', to: 'other' });
  });
});

describe('which refused turns fall inside a move', () => {
  it('those between the move out and the move back, and no others', () => {
    const { world, hop, ask } = setup();
    expect(hop.duringHop(10_000)).toBe(false);
    ask('toolu_1', 'home');
    hop.poll();
    // Still away: anything from the move out onward.
    expect(hop.duringHop(9_999)).toBe(false);
    expect(hop.duringHop(10_000)).toBe(true);
    expect(hop.duringHop(99_000)).toBe(true);
    world.now = 12_000;
    markDone(world.dir, 'toolu_1');
    hop.tick();
    expect(hop.duringHop(11_999)).toBe(true);
    expect(hop.duringHop(12_000)).toBe(true);
    // The session's own account answers from here: a refusal now is its own.
    expect(hop.duringHop(12_001)).toBe(false);
    expect(hop.duringHop(9_999)).toBe(false);
  });

  it('says no for a turn with no time on it: that one is asked of the account instead', () => {
    const { hop, ask } = setup();
    ask('toolu_1', 'home');
    hop.poll();
    expect(hop.duringHop(null)).toBe(false);
  });

  it('holds limits only while the session is away', () => {
    const { world, hop, ask } = setup();
    expect(hop.away()).toBeNull();
    ask('toolu_1', 'home');
    hop.poll();
    expect(hop.away()).not.toBeNull();
    markDone(world.dir, 'toolu_1');
    hop.tick();
    expect(hop.away()).toBeNull();
  });
});

describe('what it writes down', () => {
  it('one line when the move ends, with both accounts, how long it was held and how it ended', () => {
    const { world, hop, ask } = setup();
    ask('toolu_1', 'home');
    hop.poll();
    world.now += 1_500;
    markDone(world.dir, 'toolu_1');
    hop.tick();
    expect(world.logged).toEqual([
      {
        message: 'on "home" for one Artifact call, then back on "work"',
        data: { to: 'home', from: 'work', heldMs: 1_500, endedBy: 'done', call: 'toolu_1' },
      },
    ]);
  });

  it('says so when the move ran out of time, which is the case worth looking at', () => {
    const { world, hop, ask } = setup();
    ask('toolu_1', 'home');
    hop.poll();
    world.now += 60_000;
    hop.tick();
    expect(world.logged[0]?.message).toContain('nothing said the call was over');
    expect(world.logged[0]?.data).toMatchObject({ endedBy: 'deadline' });
  });
});
