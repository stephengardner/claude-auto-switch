import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MINUTE } from './decide.js';
import type { WatchdogEvent } from './notify.js';
import {
  loadWatchdogState,
  parseFacts,
  saveWatchdogState,
  watchdogPass,
  type WatchdogDeps,
  type WatchdogState,
  type WatcherFacts,
} from './watchdog.js';
import type { PathCtx } from '../config/paths.js';

const T0 = Date.parse('2030-01-15T12:00:00Z');
/** The watcher's machine runs four minutes behind this one. */
const SKEW = -4 * MINUTE;

function setup(over: Partial<{ restart: boolean | null }> = {}) {
  const world = {
    now: T0,
    facts: { beatAt: T0 + SKEW - 20_000, passRunning: false, now: T0 + SKEW } as WatcherFacts | null,
    state: { unreachableSince: null, unreachableTold: false, downSince: null, downTold: false, restartAt: 0 } as WatchdogState,
    passes: 0,
    restarts: 0,
    logs: [] as string[],
    events: [] as WatchdogEvent[],
  };
  const deps: WatchdogDeps = {
    host: 'my-server',
    now: () => world.now,
    facts: () => Promise.resolve(world.facts),
    runPass: () => {
      world.passes += 1;
      return Promise.resolve('nothing to do');
    },
    restart:
      over.restart === null
        ? null
        : () => {
            world.restarts += 1;
            return Promise.resolve(over.restart ?? true);
          },
    loadState: () => ({ ...world.state }),
    saveState: (state) => {
      world.state = { ...state };
    },
    log: (line) => world.logs.push(line),
    announce: (event) => {
      world.events.push(event);
      return Promise.resolve();
    },
  };
  /** What the watcher's machine reports, `ago` after its last service pass started. */
  const beatAgo = (ago: number, passRunning = false): void => {
    world.facts = { beatAt: world.now + SKEW - ago, passRunning, now: world.now + SKEW };
  };
  return { world, deps, beatAgo };
}

describe('watching the watcher from another machine', () => {
  it('does nothing while passes keep starting, whatever the two clocks say', async () => {
    const { world, deps } = setup();
    expect(await watchdogPass(deps)).toEqual({ host: 'my-server', state: 'healthy', detail: 'last pass 20s ago' });
    expect(world.passes).toBe(0);
    expect(world.restarts).toBe(0);
    expect(world.logs).toEqual([]);
  });

  it('runs a pass there and asks for a restart once no pass has started for three minutes', async () => {
    const { world, deps, beatAgo } = setup();
    beatAgo(4 * MINUTE);
    const report = await watchdogPass(deps);
    expect(report).toEqual({
      host: 'my-server',
      state: 'down',
      detail: 'no pass for 240s',
      ranPass: 'nothing to do',
      restarted: true,
    });
    expect(world.passes).toBe(1);
    expect(world.restarts).toBe(1);
    expect(world.logs).toEqual(['the watcher on my-server was not running; ran a pass there and asked for it to be started again']);
    expect(world.events).toEqual([{ type: 'watcher-down' }]);
  });

  it('never steps in while a pass is running, however old the last start', async () => {
    const { world, deps, beatAgo } = setup();
    beatAgo(10 * MINUTE, true);
    expect((await watchdogPass(deps)).state).toBe('healthy');
    expect(world.passes).toBe(0);
  });

  it('treats a service that has never run as down', async () => {
    const { world, deps } = setup();
    world.facts = { beatAt: null, passRunning: false, now: T0 + SKEW };
    expect(await watchdogPass(deps)).toMatchObject({ state: 'down', detail: 'its service has never run a pass' });
  });

  it('keeps running passes while it is down, asks for a restart once per ten minutes, and tells once', async () => {
    const { world, deps, beatAgo } = setup();
    for (let minute = 0; minute < 12; minute += 1) {
      world.now = T0 + minute * MINUTE;
      beatAgo(4 * MINUTE + minute * MINUTE);
      await watchdogPass(deps);
    }
    expect(world.passes).toBe(12);
    expect(world.restarts).toBe(2);
    expect(world.events).toHaveLength(1);
    expect(world.logs).toHaveLength(1);
  });

  it('says when the watcher runs again, and would tell of the next time afresh', async () => {
    const { world, deps, beatAgo } = setup();
    beatAgo(4 * MINUTE);
    await watchdogPass(deps);
    world.now += MINUTE;
    beatAgo(10_000);
    await watchdogPass(deps);
    expect(world.logs[1]).toBe('the watcher on my-server runs again');
    expect(world.state).toMatchObject({ downSince: null, downTold: false });

    world.now += 20 * MINUTE;
    beatAgo(5 * MINUTE);
    await watchdogPass(deps);
    expect(world.events).toHaveLength(2);
  });

  it('still runs the pass when no way to restart was given', async () => {
    const { world, deps, beatAgo } = setup({ restart: null });
    beatAgo(4 * MINUTE);
    const report = await watchdogPass(deps);
    expect(report.restarted).toBeUndefined();
    expect(world.passes).toBe(1);
    expect(world.logs).toEqual(['the watcher on my-server was not running; ran a pass there']);
  });

  it('says so when the restart did not work', async () => {
    const { world, deps, beatAgo } = setup({ restart: false });
    beatAgo(4 * MINUTE);
    expect((await watchdogPass(deps)).restarted).toBe(false);
    expect(world.logs[0]).toContain('asking for it to be started again failed');
  });
});

describe('a machine that does not answer', () => {
  it('is told about once, after five minutes of silence', async () => {
    const { world, deps } = setup();
    world.facts = null;
    for (let minute = 0; minute <= 8; minute += 1) {
      world.now = T0 + minute * MINUTE;
      expect((await watchdogPass(deps)).state).toBe('unreachable');
    }
    expect(world.events).toEqual([{ type: 'watcher-unreachable', forMs: 5 * MINUTE }]);
    expect(world.passes).toBe(0);
  });

  it('is noted when it answers again', async () => {
    const { world, deps, beatAgo } = setup();
    world.facts = null;
    await watchdogPass(deps);
    world.now += MINUTE;
    beatAgo(10_000);
    await watchdogPass(deps);
    expect(world.logs).toEqual(['my-server answers again']);
    expect(world.state.unreachableSince).toBeNull();
  });

  it('counts a question that throws as no answer', async () => {
    const { deps } = setup();
    deps.facts = () => Promise.reject(new Error('ssh: connection reset'));
    expect((await watchdogPass(deps)).state).toBe('unreachable');
  });
});

describe('what the watcher\'s machine says of itself', () => {
  it('is read from the last line of JSON it printed', () => {
    const printed = 'a line some shell profile printed\n{"beatAt":1000,"passRunning":false,"now":2000}\n';
    expect(parseFacts(printed)).toEqual({ beatAt: 1000, passRunning: false, now: 2000 });
  });

  it('reads a service that never ran', () => {
    expect(parseFacts('{"beatAt":null,"passRunning":true,"now":2000}')).toEqual({
      beatAt: null,
      passRunning: true,
      now: 2000,
    });
  });

  it('takes only what a watchdog needs, whatever else the line carries', () => {
    expect(parseFacts('{"beatAt":1,"passRunning":false,"now":2,"active":"work"}')).toEqual({
      beatAt: 1,
      passRunning: false,
      now: 2,
    });
  });

  it('is nothing when what came back is not that', () => {
    expect(parseFacts('')).toBeNull();
    expect(parseFacts('ccx: command not found')).toBeNull();
    expect(parseFacts('{"beatAt":1}')).toBeNull();
    expect(parseFacts('{ not json')).toBeNull();
  });
});

describe('what the watchdog remembers', () => {
  let home: string;
  let ctx: PathCtx;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ccx-autoswitch-watchdog-'));
    ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('is kept per machine watched, under a name safe for a file', () => {
    saveWatchdogState('me@my-server', { ...loadWatchdogState('me@my-server', ctx), restartAt: 77 }, ctx);
    expect(loadWatchdogState('me@my-server', ctx).restartAt).toBe(77);
    expect(loadWatchdogState('other', ctx).restartAt).toBe(0);
  });
});
