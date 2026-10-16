import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addAccount } from '../accounts/registry.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';
import { readEvents } from '../events/log.js';
import { loadLedger, markCapped, saveLedger } from '../ledger/ledger.js';
import type { RemoteResult } from '../remote/ssh.js';
import { takeLease } from '../session/lease.js';
import { getActive, setActive } from '../state/active.js';
import { readHandPick, recordHandPick } from '../state/hand-pick.js';
import { readSwitchRequest } from '../state/switch-request.js';
import type { LimitProbeResult } from '../usage/limit-probe.js';
import { readUsageSnapshot } from '../usage/usage-store.js';
import { MINUTE } from '../autoswitch/decide.js';
import { APPLY_EXIT } from '../autoswitch/followers.js';
import { webhookPath } from '../autoswitch/notify.js';
import { beat, loadState, passLockPath, readControls } from '../autoswitch/state.js';
import { AUTOSWITCH_EXIT, autoswitchCommand, type AutoswitchDeps } from './autoswitch.js';

const HOUR = 60 * MINUTE;

/** A ccx home with three signed-in accounts, `work` active, and a usage endpoint made of a table. */
function setup() {
  const home = mkdtempSync(path.join(tmpdir(), 'ccx-autoswitch-cmd-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  const said: string[] = [];
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: 'claude', prefixArgs: [] },
    out: (m: string) => said.push(m),
    err: (m: string) => said.push(`err: ${m}`),
    json: false,
    quiet: false,
  };
  const world = {
    now: Date.now(),
    usage: { work: 0.5, personal: 0.2, side: 0.4 } as Record<string, number | LimitProbeResult>,
    probed: [] as string[],
    posted: [] as string[],
    remote: [] as Array<{ host: string; args: string[] }>,
    remoteAnswer: { exitCode: 0, stdout: 'now on personal\n', stderr: '' } as RemoteResult,
  };
  for (const name of ['work', 'personal', 'side']) {
    const dir = path.join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: `tok-${name}`, refreshToken: `ref-${name}`, expiresAt: world.now + 8 * HOUR } }),
    );
    addAccount({ name, dir }, ctx);
  }
  setActive('work', ctx);

  const deps: AutoswitchDeps = {
    now: () => world.now,
    hostname: 'this-machine',
    usageGapMs: 0,
    // As the endpoint does, it answers for whoever the token says is asking.
    probe: (file) => {
      const { claudeAiOauth } = JSON.parse(readFileSync(file, 'utf8')) as { claudeAiOauth: { accessToken: string } };
      const name = claudeAiOauth.accessToken.replace(/^tok-/, '');
      world.probed.push(name);
      const value = world.usage[name];
      if (typeof value !== 'number') return Promise.resolve(value ?? { verdict: 'unknown', detail: 'fetch failed' });
      return Promise.resolve({
        verdict: 'allowed',
        fiveHour: value,
        sevenDay: 0.3,
        fiveHourReset: world.now + 3 * HOUR,
        sevenDayReset: world.now + 72 * HOUR,
      });
    },
    fetchImpl: ((_url: string, init: RequestInit) => {
      world.posted.push((JSON.parse(String(init.body)) as { text: string }).text);
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as typeof fetch,
    runRemote: (host, args) => {
      world.remote.push({ host, args });
      return Promise.resolve(world.remoteAnswer);
    },
    newerInstall: () => null,
  };
  const run = (action: string, args: string[] = [], options = {}) => autoswitchCommand(context, action, args, options, deps);
  /** Ten minutes on: long enough that the account in use is past its first two minutes. */
  const later = (ms: number): void => {
    world.now += ms;
  };
  return { home, ctx, context, said, world, deps, run, later };
}

describe('ccx autoswitch once', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => rmSync(s.home, { recursive: true, force: true }));

  it('reads the account in use, files the reading for the rest of ccx, and stays while there is room', async () => {
    expect(await s.run('once')).toBe(AUTOSWITCH_EXIT.nothingToDo);
    expect(s.said).toEqual(['work: fine at 50%']);
    expect(s.world.probed).toEqual(['work']);
    expect(readUsageSnapshot(s.ctx).accounts.work).toMatchObject({ fiveHour: 0.5, at: s.world.now });
    expect(getActive(s.ctx)).toBe('work');
  });

  it('moves to the account ccx would pick once the one in use is near its limit', async () => {
    s.world.usage.work = 0.9;
    s.later(10 * MINUTE);
    expect(await s.run('once')).toBe(AUTOSWITCH_EXIT.switched);
    expect(s.said).toEqual(['work: moved work to personal']);
    expect(getActive(s.ctx)).toBe('personal');
    // The target was read fresh before the move, with its own login.
    expect(s.world.probed).toContain('personal');
    expect(loadState(s.ctx)).toMatchObject({ account: { name: 'personal' }, lastSwitch: { from: 'work', to: 'personal', kind: 'early' } });
  });

  it('asks each running session on the account being left to move in place, and no other', async () => {
    // A running session holds its own copy of the login, in its own folder.
    const sessionDir = path.join(s.home, 'sessions', String(process.pid));
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok-work', expiresAt: s.world.now + 8 * HOUR } }),
    );
    takeLease('work', sessionDir, s.ctx);
    s.world.usage.work = 0.9;
    s.later(10 * MINUTE);
    await s.run('once');
    expect(readSwitchRequest(s.ctx, process.pid)).toMatchObject({ account: 'personal', mode: 'seamless' });
    // Never the shared request, which whichever session looked first would take.
    expect(readSwitchRequest(s.ctx)).toBeNull();
  });

  it('writes the switch into ccx history', async () => {
    s.world.usage.work = 0.9;
    s.later(10 * MINUTE);
    await s.run('once');
    const lines = readEvents(s.home, 10).map((e) => e.msg);
    expect(lines).toContain('auto-switch to personal (early: 90% used)');
    expect(lines.some((l) => l.startsWith('auto-switch: moved work to personal'))).toBe(true);
  });

  it('says what it would do in a dry run, and changes nothing', async () => {
    s.world.usage.work = 0.9;
    s.later(10 * MINUTE);
    expect(await s.run('once', [], { dryRun: true })).toBe(AUTOSWITCH_EXIT.switched);
    expect(s.said).toEqual(['work: would move work to personal (early: 90% used)']);
    expect(getActive(s.ctx)).toBe('work');
    expect(loadState(s.ctx).lastPassAt).toBe(0);
  });

  it('prints one line of JSON when asked', async () => {
    await s.run('once', [], { json: true });
    expect(JSON.parse(s.said[0] as string)).toEqual({
      schemaVersion: 1,
      event: 'stayed',
      account: 'work',
      read: '5-hour window 50%',
      reason: 'fine at 50%',
    });
  });

  it('never moves to an account ccx has down as refused', async () => {
    saveLedger(markCapped(loadLedger(s.ctx), { account: 'personal', now: s.world.now, backoffMinutes: 60 }), s.ctx);
    s.world.usage.work = 0.9;
    s.later(10 * MINUTE);
    await s.run('once');
    expect(getActive(s.ctx)).toBe('side');
  });

  it('skips a pass rather than run beside one that is already going', async () => {
    mkdirSync(path.dirname(passLockPath(s.ctx)), { recursive: true });
    writeFileSync(passLockPath(s.ctx), String(process.pid));
    expect(await s.run('once')).toBe(AUTOSWITCH_EXIT.nothingToDo);
    expect(s.said).toEqual(['another pass is running']);
    expect(s.world.probed).toEqual([]);
  });

  it('follows the threshold in the config as it is now, not as it was when the watcher started', async () => {
    writeFileSync(path.join(s.home, 'config.json'), JSON.stringify({ autoSwitch: { thresholdPercent: 45 } }));
    s.later(10 * MINUTE);
    expect(await s.run('once')).toBe(AUTOSWITCH_EXIT.switched);
  });
});

describe("a person's own pick, and the two switches", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
    s.world.usage.work = 0.9;
  });
  afterEach(() => rmSync(s.home, { recursive: true, force: true }));

  it('holds an early move off an account picked by hand', async () => {
    s.later(10 * MINUTE);
    setActive('work', s.ctx);
    recordHandPick('work', s.ctx, s.world.now);
    s.later(5 * MINUTE);
    expect(await s.run('once')).toBe(AUTOSWITCH_EXIT.held);
    expect(s.said).toEqual(['work: work was picked by hand, which holds against an early move']);
    expect(getActive(s.ctx)).toBe('work');
  });

  /** `work` has been the active account for ten minutes, and was picked by hand five minutes ago. */
  const pickedFiveMinutesAgo = (): void => {
    const tenMinutesAgo = new Date(Date.now() - 10 * MINUTE);
    utimesSync(path.join(s.home, 'active.json'), tenMinutesAgo, tenMinutesAgo);
    recordHandPick('work', s.ctx, Date.now() - 5 * MINUTE);
  };

  it('keeps holding for a pick after a session starts on the picked account', async () => {
    pickedFiveMinutesAgo();
    // Every session sets the active account to the one it starts on.
    setActive('work', s.ctx);
    expect(await s.run('once')).toBe(AUTOSWITCH_EXIT.held);
    expect(getActive(s.ctx)).toBe('work');
  });

  it('keeps holding for a pick on a machine that follows, after a session starts there', async () => {
    pickedFiveMinutesAgo();
    setActive('work', s.ctx);
    expect(await s.run('apply', [], { from: 'work', to: 'personal', kind: 'early', by: 'other-machine' })).toBe(APPLY_EXIT.leftAlone);
    expect(getActive(s.ctx)).toBe('work');
  });

  it('moves off a picked account once it is used up, and forgets the pick', async () => {
    recordHandPick('work', s.ctx, s.world.now);
    s.world.usage.work = 1;
    s.later(10 * MINUTE);
    await s.run('once');
    s.later(30_000);
    expect(await s.run('once')).toBe(AUTOSWITCH_EXIT.switched);
    expect(readHandPick(s.ctx)).toBeNull();
  });

  it('holds early moves when they are turned off, and says so', async () => {
    expect(await s.run('early', ['off'], { by: 'someone' })).toBe(0);
    expect(readControls(s.ctx)).toEqual({ paused: null, earlyOff: true });
    s.later(10 * MINUTE);
    expect(await s.run('once')).toBe(AUTOSWITCH_EXIT.held);
    expect(s.said.at(-1)).toBe('work: early moves are off');

    await s.run('early', ['on']);
    expect(await s.run('once')).toBe(AUTOSWITCH_EXIT.switched);
  });

  it('says where early moves stand when asked without a word', async () => {
    await s.run('early');
    expect(s.said.at(-1)).toContain('early moves are on: the watcher moves at 85% used');
    await s.run('early', ['off']);
    await s.run('early');
    expect(s.said.at(-1)).toContain('early moves are off');
  });

  it('holds every move while paused, and resume clears a pause and the early-moves switch together', async () => {
    await s.run('pause', ['upgrading', 'the', 'machine']);
    await s.run('early', ['off']);
    expect(readControls(s.ctx)).toEqual({ paused: 'upgrading the machine', earlyOff: true });
    s.later(10 * MINUTE);
    expect(await s.run('now', [], { force: true, by: 'someone' })).toBe(AUTOSWITCH_EXIT.held);

    await s.run('resume');
    expect(readControls(s.ctx)).toEqual({ paused: null, earlyOff: false });
    expect(await s.run('once')).toBe(AUTOSWITCH_EXIT.switched);
  });
});

describe('ccx autoswitch now', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => rmSync(s.home, { recursive: true, force: true }));

  it('reads at once and says there is room', async () => {
    await s.run('once');
    s.later(5_000);
    expect(await s.run('now', [], { by: 'someone' })).toBe(AUTOSWITCH_EXIT.nothingToDo);
    expect(s.world.probed).toEqual(['work', 'work']);
    expect(s.said.at(-1)).toBe('work: the account in use has room (50% used); not switching (--force switches anyway)');
  });

  it('moves when forced, and the message says who asked', async () => {
    await s.run('notify', ['https://hooks.slack.example/services/T/B/X']);
    expect(await s.run('now', [], { force: true, by: 'someone' })).toBe(AUTOSWITCH_EXIT.switched);
    expect(getActive(s.ctx)).toBe('personal');
    expect(s.world.posted).toEqual(['ccx auto-switch: moved to the next account, asked for by hand']);
  });
});

describe('the message a switch sends', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
    s.world.usage.work = 0.9;
    s.later(10 * MINUTE);
  });
  afterEach(() => rmSync(s.home, { recursive: true, force: true }));

  it('goes nowhere until a webhook is given', async () => {
    await s.run('once');
    expect(s.world.posted).toEqual([]);
    await s.run('notify');
    expect(s.said.at(-1)).toContain('no message is sent');
  });

  it('goes to Slack once one is, naming no account, and the address is never shown', async () => {
    expect(await s.run('notify', ['https://hooks.slack.example/services/T/B/SECRET'])).toBe(0);
    expect(s.said.join('\n')).not.toContain('SECRET');
    expect(s.said.at(-1)).toContain('hooks.slack.example');

    await s.run('once');
    expect(s.world.posted).toEqual(['ccx auto-switch: the account in use was near its limit; moved to the next account']);
    await s.run('status');
    expect(s.said.join('\n')).not.toContain('SECRET');
  });

  it('names accounts and carries a label when the settings say so', async () => {
    await s.run('notify', ['https://hooks.slack.example/services/T/B/X']);
    await s.run('label', ['my', 'server']);
    writeFileSync(
      path.join(s.home, 'config.json'),
      JSON.stringify({ autoSwitch: { ...(JSON.parse(readFileSync(path.join(s.home, 'config.json'), 'utf8')) as { autoSwitch: object }).autoSwitch, nameAccounts: true } }),
    );
    await s.run('once');
    expect(s.world.posted).toEqual(['[my server] ccx auto-switch: work was near its limit; moved to personal']);
  });

  it('can be tried, and turned off again', async () => {
    expect(await s.run('notify', ['test'])).toBe(1);
    await s.run('notify', ['https://hooks.slack.example/services/T/B/X']);
    expect(await s.run('notify', ['test'])).toBe(0);
    expect(s.world.posted).toEqual(['ccx auto-switch: a test message; a switch will look like this']);

    await s.run('notify', ['off']);
    expect(existsSync(webhookPath(s.ctx))).toBe(false);
  });

  it('takes the address from standard input, so it need never be typed on a command line', async () => {
    s.deps.readStdin = () => Promise.resolve('https://hooks.slack.example/services/T/B/PIPED\n');
    expect(await s.run('notify', ['-'])).toBe(0);
    expect(readFileSync(webhookPath(s.ctx), 'utf8')).toBe('https://hooks.slack.example/services/T/B/PIPED\n');
    expect(s.said.join('\n')).not.toContain('PIPED');
  });

  it('refuses an address that is not https, and saves nothing', async () => {
    expect(await s.run('notify', ['http://insecure.example/hook'])).toBe(1);
    expect(s.said.at(-1)).toBe('a webhook address starts with https://');
    expect(existsSync(webhookPath(s.ctx))).toBe(false);
  });

  it('clears the label with off', async () => {
    await s.run('label', ['my-server']);
    expect(loadConfig(s.ctx).autoSwitch.label).toBe('my-server');
    await s.run('label', ['off']);
    expect(loadConfig(s.ctx).autoSwitch.label).toBeNull();
  });
});

describe('machines that follow', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => rmSync(s.home, { recursive: true, force: true }));

  it('are added and removed by host, and a host ssh could misread is refused', async () => {
    expect(await s.run('followers', ['add', 'laptop'])).toBe(0);
    expect(await s.run('followers', ['add', 'me@desk'])).toBe(0);
    expect(await s.run('followers', ['add', 'laptop'])).toBe(0);
    expect(loadConfig(s.ctx).autoSwitch.followers).toEqual(['laptop', 'me@desk']);

    expect(await s.run('followers', ['add', '-oProxyCommand=x'])).toBe(1);
    expect(await s.run('followers', ['remove', 'laptop'])).toBe(0);
    expect(loadConfig(s.ctx).autoSwitch.followers).toEqual(['me@desk']);

    await s.run('followers');
    expect(s.said.at(-1)).toBe('  me@desk');
  });

  it('are each asked to make the same move after a switch, and counted in the message', async () => {
    await s.run('followers', ['add', 'laptop']);
    await s.run('notify', ['https://hooks.slack.example/services/T/B/X']);
    s.world.usage.work = 0.9;
    s.later(10 * MINUTE);
    await s.run('once');
    expect(s.world.remote).toEqual([
      { host: 'laptop', args: ['autoswitch', 'apply', '--from', 'work', '--to', 'personal', '--kind', 'early', '--by', 'this-machine'] },
    ]);
    expect(s.world.posted[0]).toContain('; 1 of 1 other machine followed');
  });

  it('leave a line in the history when one does not follow, and the switch here stands', async () => {
    await s.run('followers', ['add', 'laptop']);
    s.world.remoteAnswer = { exitCode: 255, stdout: '', stderr: 'ssh: connect to host laptop port 22: Connection refused\n' };
    s.world.usage.work = 0.9;
    s.later(10 * MINUTE);
    expect(await s.run('once')).toBe(AUTOSWITCH_EXIT.switched);
    expect(readEvents(s.home, 10).map((e) => e.msg)).toContain(
      'auto-switch: laptop did not follow: could not reach it (ssh: connect to host laptop port 22: Connection refused); asking again for ten minutes',
    );
  });
});

describe('ccx autoswitch apply, on a machine that follows', () => {
  let s: ReturnType<typeof setup>;
  const move = { from: 'work', to: 'personal', kind: 'early', by: 'other-machine' };
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => rmSync(s.home, { recursive: true, force: true }));

  it('makes the same move when it was on the account being left', async () => {
    expect(await s.run('apply', [], move)).toBe(APPLY_EXIT.followed);
    expect(getActive(s.ctx)).toBe('personal');
    expect(readEvents(s.home, 5).map((e) => e.msg)).toContain('auto-switch to personal (followed other-machine (early))');
  });

  it('stays put when it is on another account, or picked this one by hand', async () => {
    setActive('side', s.ctx);
    expect(await s.run('apply', [], move)).toBe(APPLY_EXIT.leftAlone);
    expect(getActive(s.ctx)).toBe('side');

    setActive('work', s.ctx);
    recordHandPick('work', s.ctx);
    expect(await s.run('apply', [], move)).toBe(APPLY_EXIT.leftAlone);
    expect(getActive(s.ctx)).toBe('work');
    expect(await s.run('apply', [], { ...move, kind: 'spent' })).toBe(APPLY_EXIT.followed);
  });

  it('refuses a request that is not one', async () => {
    expect(await s.run('apply', [], { from: 'work', to: 'personal', kind: 'whenever' })).toBe(APPLY_EXIT.failed);
    expect(await s.run('apply', [], { from: 'work', kind: 'early' })).toBe(APPLY_EXIT.failed);
    expect(getActive(s.ctx)).toBe('work');
  });

  it('says so when the account is not registered there', async () => {
    expect(await s.run('apply', [], { ...move, to: 'nowhere' })).toBe(APPLY_EXIT.failed);
    expect(s.said.at(-1)).toBe('no account "nowhere" here; add it with: ccx add nowhere');
  });
});

describe('ccx autoswitch status and stats', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => rmSync(s.home, { recursive: true, force: true }));

  it('says the watcher has never run, and how to start it', async () => {
    await s.run('status');
    const text = s.said.join('\n');
    expect(text).toContain('auto-switch:    on; moves at 85% used, to an account with 10 points more room');
    expect(text).toContain('watcher:        has never run here');
    expect(text).toContain('messages:       off');
    expect(text).toContain('followers:      none');
  });

  it('is the default action, and says what the watcher last saw and did', async () => {
    s.world.usage.work = 0.9;
    s.later(10 * MINUTE);
    await s.run('once', [], { by: 'service' });
    s.later(90 * MINUTE);
    s.said.length = 0;
    expect(await autoswitchCommand(s.context, undefined, [], {}, s.deps)).toBe(0);
    const text = s.said.join('\n');
    expect(text).toContain('watcher:        last pass 1h 30m ago, by service');
    expect(text).toContain('account in use: personal, for 1h 30m');
    expect(text).toContain('last switch:    work to personal, 1h 30m ago (early: 90% used), by service');
  });

  it('shows a pause for what it is', async () => {
    await s.run('pause', ['for', 'now']);
    s.said.length = 0;
    await s.run('status');
    expect(s.said[0]).toBe('auto-switch:    PAUSED (for now); no move of any kind. Back on with: ccx autoswitch resume');
  });

  it('warns when sessions are also set to move themselves early', async () => {
    writeFileSync(path.join(s.home, 'config.json'), JSON.stringify({ rotation: { proactivePercent: 90 } }));
    s.context.config = loadConfig(s.ctx);
    await s.run('status');
    expect(s.said.join('\n')).toContain('Two switchers with different rules undo each other');
  });

  it('prints its state as JSON for another program', async () => {
    await s.run('once');
    s.said.length = 0;
    await s.run('status', [], { json: true });
    expect(JSON.parse(s.said[0] as string)).toMatchObject({
      schemaVersion: 1,
      mode: 'on',
      active: 'work',
      thresholdPercent: 85,
      lastReading: { used: 0.5 },
      messages: null,
      followers: [],
    });
  });

  it('counts usage reads by kind and status', async () => {
    await s.run('stats');
    expect(s.said.at(-1)).toBe('no usage reads in the last 1h.');
    await s.run('once');
    s.world.usage.work = { verdict: 'unknown', detail: 'status 429' };
    s.later(MINUTE);
    await s.run('once');
    s.said.length = 0;
    await s.run('stats', [], { json: true });
    expect(JSON.parse(s.said[0] as string)).toEqual({ schemaVersion: 1, hours: 1, counts: { 'in-use 200': 1, 'in-use 429': 1 } });
  });
});

describe('ccx autoswitch run', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => rmSync(s.home, { recursive: true, force: true }));

  /** A loop that runs `passes` passes, a minute apart, then is told to stop. */
  const loop = (passes: number, each: (pass: number) => void = () => {}) => {
    const controller = new AbortController();
    let pass = 0;
    s.deps.signal = controller.signal;
    s.deps.sleep = () => {
      pass += 1;
      if (pass >= passes) controller.abort();
      else {
        s.world.now += MINUTE;
        each(pass);
      }
      return Promise.resolve();
    };
  };

  it('runs a pass, waits, and runs another until it is stopped, saying a line only when something changes', async () => {
    loop(4);
    expect(await s.run('run')).toBe(0);
    expect(s.world.probed).toEqual(['work', 'work', 'work', 'work']);
    expect(s.said).toEqual(['watching the account in use, a pass every 30s (Ctrl-C to stop)', 'work: fine at 50%']);
  });

  it('switches when the account fills up, and carries on watching the new one', async () => {
    s.later(10 * MINUTE);
    loop(4, (pass) => {
      if (pass === 1) s.world.usage.work = 0.9;
    });
    await s.run('run');
    expect(getActive(s.ctx)).toBe('personal');
    expect(s.said).toContain('work: moved work to personal');
    expect(s.world.probed.at(-1)).toBe('personal');
  });

  it('marks each pass it starts, for a watchdog on another machine to read', async () => {
    loop(1);
    await s.run('run');
    s.said.length = 0;
    await s.run('facts');
    expect(JSON.parse(s.said[0] as string)).toEqual({ beatAt: s.world.now, passRunning: false, now: s.world.now });
  });

  it('ends when a newer ccx is installed, so its service starts it again on that one', async () => {
    loop(10);
    // Where a service starts it again, which is everywhere but Windows: said
    // here, so the test means the same whatever machine runs it.
    s.deps.restartsOnExit = true;
    s.deps.newerInstall = () => ({ version: '99.0.0', cli: '/somewhere/cli.js' });
    expect(await s.run('run')).toBe(0);
    expect(s.world.probed).toEqual(['work']);
    expect(s.said.at(-1)).toBe('ccx 99.0.0 is installed; ending so the watcher starts again on it');
  });

  it('stays up on Windows when a newer ccx is installed, since nothing there would start it again', async () => {
    loop(3);
    s.deps.restartsOnExit = false;
    s.deps.newerInstall = () => ({ version: '99.0.0', cli: 'C:\\somewhere\\cli.js' });
    expect(await s.run('run')).toBe(0);
    expect(s.world.probed).toEqual(['work', 'work', 'work']);
    // Said once, not on every pass.
    expect(s.said.filter((l) => l.includes('99.0.0'))).toEqual([
      'ccx 99.0.0 is installed; this watcher stays on the old one until its task is run again (schtasks /End, then /Run)',
    ]);
  });

  it('survives a pass that throws, and the pass after it runs as usual', async () => {
    let explode = false;
    loop(3, (pass) => {
      explode = pass === 1;
    });
    s.deps.now = () => {
      if (explode) {
        explode = false;
        throw new Error('the clock fell over');
      }
      return s.world.now;
    };
    expect(await s.run('run')).toBe(0);
    // The kind of failure on standard error, which a service sends to a log others can read;
    // the reason, which can hold a path, in ccx's own history.
    expect(s.said).toContain('err: ccx autoswitch: a pass failed (Error); ccx history has the reason. Carrying on');
    expect(readEvents(s.home, 20).map((e) => e.msg)).toContain('auto-switch: a pass failed: the clock fell over');
    // The first pass and the third read; the second never got that far.
    expect(s.world.probed).toEqual(['work', 'work']);
    // And it left no lock behind for the third to trip on.
    expect(existsSync(passLockPath(s.ctx))).toBe(false);
  });
});

describe('ccx autoswitch facts', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => rmSync(s.home, { recursive: true, force: true }));

  it('says a pass is running while one holds the lock', async () => {
    mkdirSync(path.dirname(passLockPath(s.ctx)), { recursive: true });
    writeFileSync(passLockPath(s.ctx), String(process.pid));
    await s.run('facts');
    // Nothing about accounts: only what a watchdog on another machine reads.
    expect(JSON.parse(s.said[0] as string)).toEqual({ beatAt: null, passRunning: true, now: s.world.now });
    // Asking did not take the lock away from the pass that holds it.
    expect(readFileSync(passLockPath(s.ctx), 'utf8')).toBe(String(process.pid));
  });
});

describe('ccx autoswitch facts, where no lock can be made', () => {
  it('does not mistake that for a pass running, which would keep a watchdog waiting for ever', async () => {
    const s = setup();
    // A file where the watcher's folder should be: nothing can be created inside it.
    writeFileSync(path.join(s.home, 'autoswitch'), 'in the way');
    expect(await s.run('facts')).toBe(0);
    expect(JSON.parse(s.said[0] as string)).toMatchObject({ passRunning: false });
    rmSync(s.home, { recursive: true, force: true });
  });
});

describe('ccx autoswitch watchdog', () => {
  let s: ReturnType<typeof setup>;
  let asked: Array<{ host: string; args: string[]; timeoutMs?: number }>;
  let shelled: string[];
  let theirFacts: string;

  beforeEach(() => {
    s = setup();
    asked = [];
    shelled = [];
    theirFacts = JSON.stringify({ beatAt: 1_000_000 - 20_000, passRunning: false, now: 1_000_000 });
    s.deps.remoteCcx = (host, args, options) => {
      asked.push({ host, args, ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
      // The pass there found room, and says so with an account name this machine has no use for.
      if (args[1] === 'facts') return Promise.resolve({ exitCode: 0, stdout: theirFacts, stderr: '' });
      return Promise.resolve({ exitCode: AUTOSWITCH_EXIT.nothingToDo, stdout: 'work: fine at 40%\n', stderr: '' });
    };
    s.deps.remoteShell = (_host, command) => {
      shelled.push(command);
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    };
  });
  afterEach(() => rmSync(s.home, { recursive: true, force: true }));

  it('needs to be told which machine', async () => {
    expect(await s.run('watchdog')).toBe(1);
    expect(await s.run('watchdog', [], { host: '-oProxyCommand=x', once: true })).toBe(1);
  });

  it('finds a watcher that is running and leaves it alone', async () => {
    expect(await s.run('watchdog', [], { host: 'my-server', once: true })).toBe(0);
    expect(s.said).toEqual(['my-server: healthy (last pass 20s ago)']);
    expect(asked.map((a) => a.args)).toEqual([['autoswitch', 'facts']]);
    expect(shelled).toEqual([]);
  });

  it('runs a pass there and starts the watcher again when no pass has started for three minutes', async () => {
    theirFacts = JSON.stringify({ beatAt: 1_000_000 - 4 * MINUTE, passRunning: false, now: 1_000_000 });
    const code = await s.run('watchdog', [], { host: 'my-server', once: true, restart: 'systemctl --user restart ccx-autoswitch' });
    expect(code).toBe(AUTOSWITCH_EXIT.nothingToDo);
    expect(asked.map((a) => a.args)).toEqual([
      ['autoswitch', 'facts'],
      ['autoswitch', 'once', '--by', 'this-machine'],
    ]);
    expect(asked[1]?.timeoutMs).toBe(150_000);
    expect(shelled).toEqual(['systemctl --user restart ccx-autoswitch']);
    // How the pass went, from its exit code; never the line it printed, which names an account.
    expect(s.said).toEqual(['my-server: down (no pass for 240s); ran a pass there, nothing to do']);
  });

  it('runs ccx there the way it is told to', async () => {
    let options: unknown;
    s.deps.remoteCcx = (_host, _args, given) => {
      options = given;
      return Promise.resolve({ exitCode: 0, stdout: theirFacts, stderr: '' });
    };
    await s.run('watchdog', [], { host: 'my-server', once: true, remoteCcx: '/opt/node /opt/ccx' });
    expect(options).toEqual({ ccx: '/opt/node /opt/ccx' });
  });

  it('says a machine that does not answer is unreachable', async () => {
    s.deps.remoteCcx = () => Promise.resolve({ exitCode: 255, stdout: '', stderr: 'ssh: connect timed out' });
    expect(await s.run('watchdog', [], { host: 'my-server', once: true })).toBe(AUTOSWITCH_EXIT.nothingToDo);
    expect(s.said[0]).toMatch(/^my-server: unreachable \(no answer for \d+s\)$/);
  });

  it('keeps checking until it is stopped, saying a line when the state changes', async () => {
    const controller = new AbortController();
    let checks = 0;
    s.deps.signal = controller.signal;
    s.deps.sleep = () => {
      checks += 1;
      if (checks === 2) theirFacts = JSON.stringify({ beatAt: null, passRunning: false, now: 1_000_000 });
      if (checks >= 3) controller.abort();
      return Promise.resolve();
    };
    expect(await s.run('watchdog', [], { host: 'my-server' })).toBe(0);
    expect(s.said).toEqual([
      'watching the watcher on my-server, a check every 60s (Ctrl-C to stop)',
      'my-server: healthy (last pass 20s ago)',
      'my-server: down (its service has never run a pass); ran a pass there, nothing to do',
    ]);
  });
});

describe('ccx autoswitch service', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
    s.deps.nodePath = '/opt/node/bin/node';
    s.deps.cliPath = '/opt/ccx/dist/cli.js';
  });
  afterEach(() => rmSync(s.home, { recursive: true, force: true }));

  it('prints a systemd unit on Linux with this node, this ccx and this ccx home, and installs nothing', async () => {
    s.context.ctx = { ...s.ctx, platform: 'linux' };
    expect(await s.run('service')).toBe(0);
    const text = s.said.join('\n');
    expect(text).toContain('Save this as ~/.config/systemd/user/ccx-autoswitch.service:');
    expect(text).toContain('ExecStart="/opt/node/bin/node" "/opt/ccx/dist/cli.js" autoswitch run --by service');
    // The path itself is escaped for systemd, which on Windows doubles every backslash.
    expect(text).toContain('Environment="CLAUDE_AUTO_SWITCH_HOME=');
    expect(text).toContain('systemctl --user enable --now ccx-autoswitch');
    expect(text).toContain("ccx autoswitch watchdog --host <this machine> --restart 'systemctl --user restart ccx-autoswitch'");
  });

  it('prints a launch agent on macOS, and a scheduled task on Windows', async () => {
    s.context.ctx = { ...s.ctx, platform: 'darwin' };
    await s.run('service');
    expect(s.said.join('\n')).toContain('Save this as ~/Library/LaunchAgents/ccx.autoswitch.plist:');

    s.said.length = 0;
    s.context.ctx = { ...s.ctx, platform: 'win32' };
    await s.run('service');
    expect(s.said.join('\n')).toContain('schtasks /Create /SC ONLOGON /TN "ccx autoswitch"');
  });
});

describe('ccx autoswitch with a word it does not know', () => {
  it('lists what it takes', async () => {
    const s = setup();
    expect(await s.run('dance')).toBe(1);
    expect(s.said[0]).toContain('usage: ccx autoswitch <status|run|once|now|');
    rmSync(s.home, { recursive: true, force: true });
  });
});

describe('the heartbeat the service leaves', () => {
  it('is what status goes by to say its service has stopped', async () => {
    const s = setup();
    await s.run('once', [], { by: 'someone' });
    beat(s.ctx, s.world.now - 10 * MINUTE);
    s.said.length = 0;
    await s.run('status');
    expect(s.said.join('\n')).toContain('its service has not run one for 10 min');
    rmSync(s.home, { recursive: true, force: true });
  });
});
