import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addAccount } from '../accounts/registry.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';
import { readEvents } from '../events/log.js';
import { loadLedger, markCapped, saveLedger } from '../ledger/ledger.js';
import { takeLease } from '../session/lease.js';
import { getActive, setActive } from '../state/active.js';
import { readSwitchRequest } from '../state/switch-request.js';
import { switchLockPath } from '../state/switch-lock.js';
import type { LimitProbeResult } from '../usage/limit-probe.js';
import { rememberDeadLogin } from '../usage/dead-login-store.js';
import { credentialFileFingerprint } from '../accounts/credential-vault.js';
import { saveWebhook } from './notify.js';
import type { TargetCandidate } from './target.js';
import { announce, buildPassDeps, reloadConfig, switchUnderLock, watchAccounts } from './wiring.js';

const HOUR = 3_600_000;

function setup() {
  const home = mkdtempSync(path.join(tmpdir(), 'ccx-autoswitch-wiring-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: 'claude', prefixArgs: [] },
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
  };
  const now = Date.now();
  const login = (dir: string, name: string, expiresAt = now + 8 * HOUR): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: `tok-${name}`, refreshToken: `ref-${name}`, expiresAt } }),
    );
  };
  for (const name of ['work', 'personal']) {
    const dir = path.join(home, 'profiles', name);
    login(dir, name);
    addAccount({ name, dir, email: `${name}@example.com` }, ctx);
  }
  setActive('work', ctx);
  return { home, ctx, context, now, login };
}

describe('the switch the watcher makes', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => rmSync(s.home, { recursive: true, force: true }));

  it('sets the active account and asks the sessions on the one being left to follow, each by its own request', () => {
    takeLease('work', path.join(s.home, 'sessions', String(process.pid)), s.ctx);
    const outcome = switchUnderLock(s.context, 'work', 'personal', 'early: 90% used', { now: s.now, waitMs: 0 });
    expect(outcome).toEqual({ code: 'done', sessions: 1 });
    expect(getActive(s.ctx)).toBe('personal');
    expect(readSwitchRequest(s.ctx, process.pid)).toMatchObject({ account: 'personal', mode: 'seamless', at: s.now });
    expect(readSwitchRequest(s.ctx)).toBeNull();
    expect(readEvents(s.home, 5)[0]).toMatchObject({
      msg: 'auto-switch to personal (early: 90% used)',
      kind: 'auto-switch',
      data: { from: 'work', to: 'personal', sessions: 1 },
    });
  });

  it('leaves a session on another account where it is', () => {
    takeLease('personal', path.join(s.home, 'sessions', String(process.pid)), s.ctx);
    expect(switchUnderLock(s.context, 'work', 'personal', 'early', { now: s.now, waitMs: 0 })).toEqual({ code: 'done', sessions: 0 });
    expect(readSwitchRequest(s.ctx, process.pid)).toBeNull();
  });

  it('does nothing when somebody switched first', () => {
    setActive('personal', s.ctx);
    expect(switchUnderLock(s.context, 'work', 'personal', 'early', { now: s.now, waitMs: 0 })).toEqual({
      code: 'changed',
      active: 'personal',
    });
  });

  it('does nothing while another switch holds the lock', () => {
    writeFileSync(switchLockPath(s.ctx), String(process.pid));
    expect(switchUnderLock(s.context, 'work', 'personal', 'early', { now: s.now, waitMs: 0 })).toEqual({ code: 'busy' });
    expect(getActive(s.ctx)).toBe('work');
  });

  it('refuses an account that is not registered, leaving the active one as it was', () => {
    expect(switchUnderLock(s.context, 'work', 'nowhere', 'early', { now: s.now, waitMs: 0 })).toEqual({
      code: 'failed',
      why: 'no account "nowhere"',
    });
    expect(getActive(s.ctx)).toBe('work');
  });
});

describe('the accounts as the watcher weighs them', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => rmSync(s.home, { recursive: true, force: true }));

  it('are signed in and usable by default', () => {
    expect(watchAccounts(s.context, s.now)).toMatchObject([
      { name: 'work', email: 'work@example.com', enabled: true, loggedIn: true, capped: false },
      { name: 'personal', enabled: true, loggedIn: true, capped: false },
    ]);
  });

  it('show an account ccx has down as refused, and a login the token endpoint turned away', () => {
    saveLedger(markCapped(loadLedger(s.ctx), { account: 'personal', now: s.now, backoffMinutes: 60 }), s.ctx);
    rememberDeadLogin(credentialFileFingerprint(path.join(s.home, 'profiles', 'work')), 'invalid_grant', s.ctx);
    const [work, personal] = watchAccounts(s.context, s.now);
    expect(work).toMatchObject({ loggedIn: false });
    expect(personal).toMatchObject({ capped: true });
  });
});

describe('the watcher joined to ccx', () => {
  let s: ReturnType<typeof setup>;
  let probed: string[];
  const answer: LimitProbeResult = { verdict: 'allowed', fiveHour: 0.4, sevenDay: 0.2 };
  beforeEach(() => {
    s = setup();
    probed = [];
  });
  afterEach(() => rmSync(s.home, { recursive: true, force: true }));

  const deps = (over: Parameters<typeof buildPassDeps>[1] = {}) =>
    buildPassDeps(s.context, {
      now: () => s.now,
      usageGapMs: 0,
      probe: (file) => {
        probed.push(file);
        return Promise.resolve(answer);
      },
      ...over,
    });
  const work = () => watchAccounts(s.context, s.now)[0]!;

  it('reads usage with the profile login when no session is on the account', async () => {
    const read = await deps().read(work(), 'in-use');
    expect(read).toMatchObject({ ok: true, usage: { fiveHour: 0.4 } });
    expect(probed).toEqual([path.join(s.home, 'profiles', 'work', '.credentials.json')]);
  });

  it("reads usage with a running session's own copy of the login, which is the one kept renewed", async () => {
    const sessionDir = path.join(s.home, 'sessions', String(process.pid));
    s.login(sessionDir, 'work');
    takeLease('work', sessionDir, s.ctx);
    await deps().read(work(), 'in-use');
    expect(probed).toEqual([path.join(sessionDir, '.credentials.json')]);
  });

  it('turns a probe that throws into a failed read', async () => {
    const read = await deps({ probe: () => Promise.reject(new Error('socket hang up')) }).read(work(), 'in-use');
    expect(read).toEqual({ ok: false, status: 'unknown' });
  });

  it('knows a token that has expired from one that has not', () => {
    expect(deps().tokenLive(work())).toBe(true);
    s.login(path.join(s.home, 'profiles', 'work'), 'work', s.now - 1000);
    expect(deps().tokenLive(work())).toBe(false);
  });

  it('asks ccx for every account when a move is due, through the same stand-in for the endpoint', async () => {
    const usage = await deps().usage();
    expect([...usage.keys()].sort()).toEqual(['personal', 'work']);
    expect(usage.get('personal')).toMatchObject({ fiveHour: 0.4, sevenDay: 0.2 });
    expect(probed).toHaveLength(2);
  });

  it('takes its threshold and room from the settings, as fractions', () => {
    expect(deps().settings()).toEqual({ threshold: 0.85, hysteresis: 0.1 });
    expect(deps({ model: 'fable' }).settings()).toEqual({ threshold: 0.85, hysteresis: 0.1, model: 'fable' });
  });

  it("orders targets the way ccx is set to pick: by your own order when that is the rule", () => {
    writeFileSync(path.join(s.home, 'config.json'), JSON.stringify({ rotation: { accountOrder: 'priority' } }));
    reloadConfig(s.context);
    const candidate = (name: string, priority: number): TargetCandidate => ({
      name,
      priority,
      enabled: true,
      loggedIn: true,
      capped: false,
      usage: null,
    });
    const sorted = [candidate('b', 2), candidate('a', 2), candidate('z', 1)].sort(deps().order());
    expect(sorted.map((c) => c.name)).toEqual(['z', 'a', 'b']);
  });

  it('says in the history since when the ledger has an account down as refused', () => {
    expect(deps().cappedSince('work')).toBeNull();
    saveLedger(markCapped(loadLedger(s.ctx), { account: 'work', now: s.now - 60_000, backoffMinutes: 60 }), s.ctx);
    expect(deps().cappedSince('work')).toBe(s.now - 60_000);
  });

  it('asks only the machines named when asking again, and never one taken off the list since', async () => {
    writeFileSync(path.join(s.home, 'config.json'), JSON.stringify({ autoSwitch: { followers: ['laptop', 'desk'] } }));
    reloadConfig(s.context);
    const asked: string[] = [];
    const follow = deps({
      runRemote: (host) => (asked.push(host), Promise.resolve({ exitCode: 255, stdout: '', stderr: 'no route to host\n' })),
    }).follow;

    await follow('work', 'personal', 'early');
    expect(asked).toEqual(['laptop', 'desk']);
    // Said once, with what happens next; asking again adds no line.
    const lines = (): string[] => readEvents(s.home, 10).map((e) => e.msg);
    expect(lines()).toContain('auto-switch: laptop did not follow: could not reach it (no route to host); asking again for ten minutes');
    const before = lines().length;

    asked.length = 0;
    await follow('work', 'personal', 'early', ['desk', 'gone-since']);
    expect(asked).toEqual(['desk']);
    expect(lines()).toHaveLength(before);
  });

  it('asks no machine when none follows', async () => {
    const asked: string[] = [];
    const follow = deps({ runRemote: (host) => (asked.push(host), Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })) }).follow;
    expect(await follow('work', 'personal', 'early')).toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe('the settings a long-running watcher reads', () => {
  it('follow the file, and stay as they were when the file stops loading', () => {
    const s = setup();
    writeFileSync(path.join(s.home, 'config.json'), JSON.stringify({ autoSwitch: { thresholdPercent: 70 } }));
    reloadConfig(s.context);
    expect(s.context.config.autoSwitch.thresholdPercent).toBe(70);

    writeFileSync(path.join(s.home, 'config.json'), '{ half an edit');
    reloadConfig(s.context);
    expect(s.context.config.autoSwitch.thresholdPercent).toBe(70);
    rmSync(s.home, { recursive: true, force: true });
  });
});

describe('telling of a switch', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => rmSync(s.home, { recursive: true, force: true }));

  const event = { type: 'no-room', account: 'work', until: null } as const;

  it('sends nothing without a webhook', async () => {
    let sent = 0;
    await announce(s.context, event, { fetchImpl: (() => ((sent += 1), Promise.resolve(new Response('ok')))) as typeof fetch });
    expect(sent).toBe(0);
  });

  it('leaves a line in the history when the message cannot be sent, and does not throw', async () => {
    saveWebhook('https://hooks.slack.example/services/T/B/X', s.ctx);
    await announce(s.context, event, { fetchImpl: (() => Promise.resolve(new Response('gone', { status: 410 }))) as typeof fetch });
    expect(readEvents(s.home, 5).map((e) => e.msg)).toEqual(['auto-switch: the message could not be sent (status 410)']);
  });
});
