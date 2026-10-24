import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from '../../src/commands/run.js';
import { addAccount } from '../../src/accounts/registry.js';
import { getActive, setActive } from '../../src/state/active.js';
import { loadConfig } from '../../src/config/config.js';
import { sessionDirFor } from '../../src/session/session-dir.js';
import { writeSwitchRequest } from '../../src/state/switch-request.js';
import { liveLeases } from '../../src/session/lease.js';
import type { CliContext } from '../../src/context.js';
import type { LimitVerdict } from '../../src/usage/limit-probe.js';
import { watchRelay, type RelayedLine } from './relay-watch.js';
import { FAKE_ENV, PTY_AVAILABLE, fakeClaude, freshUsage, launches, readLog } from './typeable-claude.js';

/**
 * A move in place under a running Claude on macOS, where every login lives in
 * the Keychain and `security` takes 100 ms a call. Here `security` is a
 * stand-in: the Keychain is a map in this process, and each call is noted with
 * what it did, when, and whether it held the thread (the form that blocks) or
 * left it free.
 */
type Call = { dir: string; what: 'read' | 'write' | 'delete'; blocking: boolean; text?: string };
const fake = vi.hoisted(() => ({
  items: new Map<string, string>(),
  calls: [] as Array<{
    dir: string;
    what: 'read' | 'write' | 'delete';
    blocking: boolean;
    text?: string;
    start: number;
    end: number;
    /** For a read, whether a move made it (through the view's vouched read), by the stack it was made from. */
    byMove: boolean;
  }>,
  /** Told of each call as it starts. */
  onCall: null as null | ((call: { dir: string; what: string; text?: string }) => void),
  /** Which writes go in and are then reported failed: their check fails, and the old login cannot be put back. */
  refuses: null as null | ((dir: string, text: string) => boolean),
  /** How long each call takes. */
  takesMs: 100,
}));
vi.mock('../../src/accounts/keychain.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/accounts/keychain.js')>();
  const answer = (call: Call): string | null => {
    if (call.what === 'read') return fake.items.get(call.dir) ?? null;
    if (call.what === 'delete') {
      fake.items.delete(call.dir);
      return null;
    }
    const text = call.text ?? '';
    fake.items.set(call.dir, text.trim());
    if (fake.refuses?.(call.dir, text)) throw new Error('Could not save the profile login in macOS Keychain');
    return null;
  };
  const byMove = (): boolean => (new Error().stack ?? '').includes('readVouched');
  const blocking = (call: Call): string | null => {
    const start = Date.now();
    const move = byMove();
    fake.onCall?.(call);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, fake.takesMs);
    try {
      return answer(call);
    } finally {
      fake.calls.push({ ...call, start, end: Date.now(), byMove: move });
    }
  };
  const waiting = async (call: Call): Promise<string | null> => {
    const start = Date.now();
    const move = byMove();
    fake.onCall?.(call);
    await new Promise((resolve) => setTimeout(resolve, fake.takesMs));
    try {
      return answer(call);
    } finally {
      fake.calls.push({ ...call, start, end: Date.now(), byMove: move });
    }
  };
  return {
    ...real,
    readKeychainCredential: (dir: string) => blocking({ dir, what: 'read', blocking: true }),
    writeKeychainCredential: (dir: string, text: string) => void blocking({ dir, what: 'write', blocking: true, text }),
    deleteKeychainCredential: (dir: string) => void blocking({ dir, what: 'delete', blocking: true }),
    readKeychainCredentialAsync: (dir: string) => waiting({ dir, what: 'read', blocking: false }),
    writeKeychainCredentialAsync: async (dir: string, text: string) => void (await waiting({ dir, what: 'write', blocking: false, text })),
    deleteKeychainCredentialAsync: async (dir: string) => void (await waiting({ dir, what: 'delete', blocking: false })),
  };
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const HOURS = 3_600_000;
/** Account `name`'s login, generation `gen`. */
const loginOf = (name: string, gen: number): string =>
  JSON.stringify({
    account: name,
    claudeAiOauth: { accessToken: `a-${name}-${gen}`, refreshToken: `r-${name}-${gen}`, expiresAt: Date.now() + 8 * HOURS },
  });
const tokenOf = (text: string | undefined | null): string | null => {
  try {
    return (JSON.parse(text ?? '') as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
};
/** Until `ok` says so or `ms` have passed; never throws, so what was reached is asserted on afterwards. */
async function until(ok: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok() && Date.now() < deadline) await sleep(25);
}

interface Scene {
  home: string;
  context: CliContext;
  folder: string;
  runsLog: string;
  exitClaude: string;
  profile: (name: string) => string;
}

/** A profile signed in as on macOS: who it is in its state, its login in the Keychain only, set up a while ago. */
function addProfile(home: string, ctx: CliContext['ctx'], name: string): string {
  const dir = path.join(home, 'profiles', name);
  mkdirSync(dir, { recursive: true });
  const email = `${name.toLowerCase()}@example.com`;
  addAccount({ name, dir, email }, ctx);
  writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: `uuid-${name}` }, userID: `user-${name}` }),
  );
  fake.items.set(dir, loginOf(name, 1));
  const before = new Date(Date.now() - 60_000);
  utimesSync(dir, before, before);
  return dir;
}

/** A session on A with B beside it. Claude prints a stamped line every 100 ms until the test ends it. */
function scene(
  options: { verifyCap?: () => Promise<LimitVerdict>; env?: Record<string, string>; more?: Partial<CliContext> } = {},
): Scene {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-move-off-thread-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    verifyCap: options.verifyCap ?? (() => Promise.resolve('allowed')),
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
    ...options.more,
  };
  context.config.resume.auto = false;
  for (const name of ['A', 'B']) addProfile(home, ctx, name);
  freshUsage(home, ['A', 'B']);
  setActive('A', ctx);
  // Who a login belongs to, as the API says: X's tokens are x@example.com's. Nothing else answers.
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const who = /^Bearer a-([A-Z])-/.exec(new Headers(init?.headers).get('authorization') ?? '')?.[1];
    if (url.endsWith('/api/oauth/profile') && who) {
      return Promise.resolve(new Response(JSON.stringify({ account: { email_address: `${who.toLowerCase()}@example.com` } })));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
  const runsLog = path.join(home, 'runs.jsonl');
  const exitClaude = path.join(home, 'claude-exit');
  Object.assign(process.env, {
    FAKE_CLAUDE_RUNS_LOG: runsLog,
    FAKE_CLAUDE_IDLE_MS: '50000',
    FAKE_CLAUDE_EXIT_WHEN: exitClaude,
    FAKE_CLAUDE_CHATTER_EVERY_MS: '100',
    FAKE_CLAUDE_CHATTER_STAMP: '1',
    ...options.env,
  });
  return {
    home,
    context,
    folder: sessionDirFor(process.pid, ctx),
    runsLog,
    exitClaude,
    profile: (name) => path.join(home, 'profiles', name),
  };
}

/** Claude 2.1.302 saving its login in `folder`: in the Keychain item named after it, inside its lock there, the file gone. */
function claudeSaves(folder: string, text: string, renewing = false): void {
  const locks = [...(renewing ? [path.join(folder, '.oauth_refresh.lock')] : []), path.join(folder, '.storage-write.lock')];
  for (const lock of locks) mkdirSync(lock);
  fake.items.set(folder, text);
  rmSync(path.join(folder, '.credentials.json'), { force: true });
  for (const lock of [...locks].reverse()) rmdirSync(lock);
}

function events(s: Scene): Array<{ at: number; msg: string; kind?: string }> {
  const file = path.join(s.home, 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { at: number; msg: string; kind?: string });
}
const said = (s: Scene, start: string): Array<{ at: number; msg: string }> => events(s).filter((e) => e.msg.startsWith(start));
const switchedTo = (s: Scene, name: string): Array<{ at: number; msg: string }> => said(s, `switching to "${name}"`);

/** The `security` calls that held the thread while Claude ran, and the lines Claude wrote that waited behind one. */
function heldUp(lines: RelayedLine[]): { calls: typeof fake.calls; lines: RelayedLine[] } {
  const first = lines[0]?.writtenAt ?? 0;
  const last = lines.at(-1)?.relayedAt ?? 0;
  const blocking = fake.calls.filter((c) => c.blocking);
  return {
    calls: blocking.filter((c) => c.end > first && c.start < last),
    lines: lines.filter((l) => blocking.some((c) => c.start < l.relayedAt && c.end > l.writtenAt)),
  };
}

/** The blocking `security` calls while Claude ran, said as what each did to which folder of the home. */
const blockingWhileRunning = (s: Scene, lines: RelayedLine[]): string[] =>
  heldUp(lines).calls.map((c) => `${c.what} ${path.relative(s.home, c.dir)}`);

/** Run a session on A through `act`, which starts once Claude is up and has saved its login in the Keychain, then end it. */
async function run(s: Scene, act: () => Promise<void>): Promise<{ exit: number; lines: RelayedLine[] }> {
  const relay = watchRelay();
  try {
    const running = runCommand(s.context, []);
    await until(() => relay.lines().length > 0, 30_000);
    claudeSaves(s.folder, loginOf('A', 1));
    // Read again by the session, and settled.
    await sleep(3_000);
    await act();
    writeFileSync(s.exitClaude, '');
    const exit = await running;
    return { exit, lines: relay.lines() };
  } finally {
    relay.stop();
  }
}

describe.skipIf(!PTY_AVAILABLE && !process.env.CI)('a move in place under a running Claude, every `security` call taking 100 ms', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const name of [...FAKE_ENV, 'FAKE_CLAUDE_CHATTER_EVERY_MS', 'FAKE_CLAUDE_CHATTER_STAMP', 'FAKE_CLAUDE_CAP_AFTER_MS', 'FAKE_CLAUDE_CAP_EVERY_MS']) {
      delete process.env[name];
    }
    fake.items.clear();
    fake.calls.length = 0;
    fake.onCall = null;
    fake.refuses = null;
    fake.takesMs = 100;
  });

  it("keeps relaying Claude's lines on time while the move reads and writes the Keychain", { timeout: 60_000 }, async () => {
    const s = scene();
    let askedAt = 0;
    const { exit, lines } = await run(s, async () => {
      askedAt = Date.now();
      writeSwitchRequest('B', askedAt, 'seamless', s.context.ctx, process.pid);
      await until(() => switchedTo(s, 'B').length > 0, 15_000);
      await sleep(1_000);
    });
    const held = heldUp(lines);
    // Nothing ran `security` holding the thread that relays Claude...
    expect(blockingWhileRunning(s, lines)).toEqual([]);
    // ...so no line it wrote waited behind one.
    expect(held.lines).toEqual([]);
    const notice = switchedTo(s, 'B');
    expect(notice).toHaveLength(1);
    const move = fake.calls.filter((c) => c.start >= askedAt && c.end <= (notice[0]?.at ?? 0));
    console.log(
      `the Keychain calls while the move was made: ${move
        .map((c) => `${c.what} ${path.relative(s.home, c.dir)}${c.what === 'read' && !c.byMove ? ' (not by the move)' : ''}${c.blocking ? ' (blocking)' : ''}`)
        .join(', ')}`,
    );
    // The login it left saved home, then the next one put in, each off the thread.
    expect(move.filter((c) => c.what === 'write').map((c) => [c.dir, c.blocking])).toEqual([
      [s.profile('A'), false],
      [s.folder, false],
    ]);
    // B's login, read before and unchanged since, is not read again.
    expect(move.filter((c) => c.dir === s.profile('B'))).toEqual([]);
    expect(tokenOf(fake.items.get(s.folder))).toBe('a-B-1');
    expect(launches(readLog(s.runsLog))).toHaveLength(1);
    expect(exit).toBe(0);
  });

  it('puts in the login as it is when another ccx renews it during the move, and saves home the one Claude renewed just before', { timeout: 60_000 }, async () => {
    const s = scene();
    let askedAt = 0;
    let renewedB = 0;
    const { exit, lines } = await run(s, async () => {
      // Claude renews its login under its locks, not read again by the session yet.
      claudeSaves(s.folder, loginOf('A', 2), true);
      // Another ccx renews B's under B's lock as the move, having saved A's
      // login home, reads it back: the last call before it puts B's in.
      let savedA = false;
      fake.onCall = (call) => {
        if (renewedB > 0 || call.dir !== s.profile('A')) return;
        if (call.what === 'write') savedA = true;
        else if (savedA) {
          const lock = path.join(s.profile('B'), '.oauth_refresh.lock');
          mkdirSync(lock);
          fake.items.set(s.profile('B'), loginOf('B', 2));
          rmdirSync(lock);
          renewedB = Date.now();
        }
      };
      askedAt = Date.now();
      writeSwitchRequest('B', askedAt, 'seamless', s.context.ctx, process.pid);
      await until(() => switchedTo(s, 'B').length > 0, 15_000);
      await sleep(500);
    });
    expect(renewedB).toBeGreaterThan(askedAt);
    const installed = fake.calls.filter((c) => c.dir === s.folder && c.what === 'write' && c.start >= askedAt);
    expect(tokenOf(installed[0]?.text)).toBe('a-B-2');
    expect(tokenOf(fake.items.get(s.profile('A')))).toBe('a-A-2');
    expect(blockingWhileRunning(s, lines)).toEqual([]);
    expect(exit).toBe(0);
  });

  it('acts on no request while a move is under way, and on the next one once it has finished', { timeout: 60_000 }, async () => {
    const s = scene();
    let askedBack = 0;
    const { exit, lines } = await run(s, async () => {
      // Asked back to A as the move to B begins, with its Keychain work still to do.
      fake.onCall = (call) => {
        if (askedBack === 0 && call.dir === s.folder) {
          askedBack = Date.now();
          writeSwitchRequest('A', askedBack, 'seamless', s.context.ctx, process.pid);
        }
      };
      writeSwitchRequest('B', Date.now(), 'seamless', s.context.ctx, process.pid);
      await until(() => switchedTo(s, 'A').length > 0, 20_000);
      await sleep(500);
    });
    expect(askedBack).toBeGreaterThan(0);
    const toB = switchedTo(s, 'B');
    const toA = switchedTo(s, 'A');
    expect(toB).toHaveLength(1);
    expect(toA).toHaveLength(1);
    const writes = fake.calls.filter((c) => c.dir === s.folder && c.what === 'write');
    const intoB = writes.find((c) => tokenOf(c.text) === 'a-B-1');
    const intoA = writes.find((c) => c.start > askedBack && (tokenOf(c.text) ?? '').startsWith('a-A-'));
    // Said to be on B only once B's login was in, and moved back only after that.
    expect(toB[0]?.at ?? 0).toBeGreaterThanOrEqual(intoB?.end ?? Infinity);
    expect(intoA?.start ?? 0).toBeGreaterThanOrEqual(toB[0]?.at ?? Infinity);
    expect(tokenOf(fake.items.get(s.folder))).toMatch(/^a-A-/);
    expect(blockingWhileRunning(s, lines)).toEqual([]);
    expect(launches(readLog(s.runsLog))).toHaveLength(1);
    expect(exit).toBe(0);
  });

  it('rolls back a move that fails partway, after its Keychain work began, and says nothing of the account it was going to', { timeout: 60_000 }, async () => {
    const s = scene();
    let askedAt = 0;
    let leasesOnB: unknown[] = [];
    // The write that puts B's login in goes in, then fails.
    fake.refuses = (dir, text) => dir === s.folder && tokenOf(text) === 'a-B-1';
    const { exit, lines } = await run(s, async () => {
      askedAt = Date.now();
      writeSwitchRequest('B', askedAt, 'seamless', s.context.ctx, process.pid);
      await until(() => said(s, 'could not move this session to "B"').length > 0, 15_000);
      await sleep(1_000);
      leasesOnB = liveLeases(s.context.ctx).filter((l) => l.account === 'B');
    });
    const refused = fake.calls.find((c) => c.dir === s.folder && c.what === 'write' && tokenOf(c.text) === 'a-B-1');
    // It had begun: the Keychain was read and written off the thread before the write refused.
    expect(refused?.blocking).toBe(false);
    const before = fake.calls.filter((c) => c.start >= askedAt && c.end <= (refused?.start ?? 0));
    expect(before.filter((c) => !c.blocking && c.what === 'write').map((c) => c.dir)).toEqual([s.profile('A')]);
    // Rolled back: the session's login and who it says it is are A's.
    expect(tokenOf(fake.items.get(s.folder))).toBe('a-A-1');
    const state = JSON.parse(readFileSync(path.join(s.folder, '.claude.json'), 'utf8')) as { oauthAccount?: { emailAddress?: string } };
    expect(state.oauthAccount?.emailAddress).toBe('a@example.com');
    // Nothing said of B: no announcement left on it, no switch, the active account as it was.
    expect(leasesOnB).toEqual([]);
    expect(switchedTo(s, 'B')).toEqual([]);
    expect(said(s, 'could not move this session to "B"')).toHaveLength(1);
    expect(getActive(s.context.ctx)).toBe('A');
    expect(blockingWhileRunning(s, lines)).toEqual([]);
    expect(launches(readLog(s.runsLog))).toHaveLength(1);
    expect(exit).toBe(0);
  });

  it('moves a session a limit was met in, on timers, and says so once the move has finished', { timeout: 60_000 }, async () => {
    let checks = 0;
    const s = scene({
      verifyCap: () => Promise.resolve(++checks === 1 ? 'limited' : 'allowed'),
      // The limit shows once Claude has saved its login, and again and again after.
      env: { FAKE_CLAUDE_CAP_AFTER_MS: '4500', FAKE_CLAUDE_CAP_EVERY_MS: '300' },
    });
    const relief = (): Array<{ at: number; msg: string }> => said(s, 'seamless cap relief: A -> B');
    const { exit, lines } = await run(s, async () => {
      await until(() => relief().length > 0, 25_000);
      await sleep(500);
    });
    expect(relief()).toHaveLength(1);
    const intoB = fake.calls.find((c) => c.dir === s.folder && c.what === 'write' && tokenOf(c.text) === 'a-B-1');
    expect(intoB?.blocking).toBe(false);
    expect(relief()[0]?.at ?? 0).toBeGreaterThanOrEqual(intoB?.end ?? Infinity);
    expect(blockingWhileRunning(s, lines)).toEqual([]);
    expect(tokenOf(fake.items.get(s.folder))).toBe('a-B-1');
    expect(launches(readLog(s.runsLog))).toHaveLength(1);
    expect(exit).toBe(0);
  });

  it('finishes a move under way before the session ends, and ends on the account it moved to', { timeout: 60_000 }, async () => {
    const s = scene();
    let endedAt = 0;
    const { exit, lines } = await run(s, async () => {
      // Claude ends as the move to B saves A's login home, with most of its
      // Keychain work, slower here, still to do.
      fake.takesMs = 400;
      fake.onCall = (call) => {
        if (endedAt === 0 && call.dir === s.profile('A')) {
          endedAt = Date.now();
          writeFileSync(s.exitClaude, '');
        }
      };
      writeSwitchRequest('B', Date.now(), 'seamless', s.context.ctx, process.pid);
      await until(() => endedAt > 0, 15_000);
    });
    expect(endedAt).toBeGreaterThan(0);
    expect(switchedTo(s, 'B')).toHaveLength(1);
    expect(tokenOf(fake.items.get(s.folder))).toBe('a-B-1');
    // Nothing is left saying the ended session is on any account.
    expect(liveLeases(s.context.ctx).filter((l) => l.pid === process.pid)).toEqual([]);
    expect(blockingWhileRunning(s, lines)).toEqual([]);
    expect(exit).toBe(0);
  });

  it('reads no limit off the screen while a move is under way', { timeout: 60_000 }, async () => {
    const checks: number[] = [];
    const s = scene({
      verifyCap: () => {
        checks.push(Date.now());
        return Promise.resolve('allowed');
      },
      // Limit words on screen all along, each refuted, and never taken for a stuck session.
      env: { FAKE_CLAUDE_CAP_AFTER_MS: '3000', FAKE_CLAUDE_CAP_EVERY_MS: '150' },
      more: { refuteBackoffMs: 50, blockedWatch: { after: 1_000 } },
    });
    let askedAt = 0;
    const { exit, lines } = await run(s, async () => {
      await until(() => checks.length > 0, 10_000);
      askedAt = Date.now();
      writeSwitchRequest('B', askedAt, 'seamless', s.context.ctx, process.pid);
      await until(() => switchedTo(s, 'B').length > 0, 15_000);
      await sleep(1_000);
    });
    const movedAt = switchedTo(s, 'B')[0]?.at ?? 0;
    const firstOfMove = fake.calls.find((c) => c.start >= askedAt && c.dir === s.folder)?.start ?? Infinity;
    expect(movedAt).toBeGreaterThan(0);
    expect(checks.filter((at) => at >= firstOfMove && at <= movedAt)).toEqual([]);
    // Read again once it had finished.
    expect(checks.filter((at) => at > movedAt).length).toBeGreaterThan(0);
    expect(blockingWhileRunning(s, lines)).toEqual([]);
    expect(exit).toBe(0);
  });

  it('reads the login of an account added while Claude runs off the thread, and moves onto it', { timeout: 60_000 }, async () => {
    const s = scene();
    const { exit, lines } = await run(s, async () => {
      // Added, and asked for, in the same moment.
      addProfile(s.home, s.context.ctx, 'C');
      writeSwitchRequest('C', Date.now(), 'seamless', s.context.ctx, process.pid);
      await until(() => switchedTo(s, 'C').length > 0, 15_000);
      await sleep(500);
    });
    expect(blockingWhileRunning(s, lines)).toEqual([]);
    // Read off the thread before the session was moved onto it.
    const movedAt = switchedTo(s, 'C')[0]?.at ?? 0;
    expect(fake.calls.some((c) => c.dir === s.profile('C') && !c.blocking && c.end <= movedAt)).toBe(true);
    expect(switchedTo(s, 'C')).toHaveLength(1);
    expect(tokenOf(fake.items.get(s.folder))).toBe('a-C-1');
    expect(exit).toBe(0);
  });
});
