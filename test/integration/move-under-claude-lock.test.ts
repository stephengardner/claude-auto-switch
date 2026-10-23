import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addCommand } from '../../src/commands/add.js';
import { runCommand } from '../../src/commands/run.js';
import { setActive } from '../../src/state/active.js';
import { readSwitchRequest, writeSwitchRequest } from '../../src/state/switch-request.js';
import { loadConfig } from '../../src/config/config.js';
import { sessionDirFor } from '../../src/session/session-dir.js';
import { CREDENTIALS_LOCK_DIR } from '../../src/claude/locks.js';
import type { CliContext } from '../../src/context.js';
import { triesWhileALineWaited, watchLockDirTries, watchRelay } from './relay-watch.js';
import { FAKE_ENV, PTY_AVAILABLE, fakeClaude, freshUsage, launches, readLog } from './typeable-claude.js';

/**
 * A move under a running Claude, while that Claude holds one of the locks it
 * takes around its login (`.oauth_refresh.lock`, held through a renewal) and
 * its state (`.claude.json.lock`): nothing is written past either, and the
 * thread that relays Claude's terminal never waits for them. The test holds
 * the lock as Claude would.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok() && Date.now() < deadline) await sleep(25);
}

interface Scene {
  home: string;
  context: CliContext;
  runsLog: string;
  exitClaude: string;
  folder: string;
}

async function scene(verifyCap?: () => Promise<'limited' | 'allowed'>): Promise<Scene> {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-move-locked-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    verifyCap: verifyCap ?? (() => Promise.resolve('allowed')),
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
  };
  context.config.resume.auto = false;
  for (const name of ['A', 'B']) {
    const dir = path.join(home, 'profiles', name);
    await addCommand(context, name, { dir, login: false });
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }), 'utf8');
  }
  freshUsage(home, ['A', 'B']);
  setActive('A', ctx);
  const runsLog = path.join(home, 'runs.jsonl');
  const exitClaude = path.join(home, 'claude-exit');
  Object.assign(process.env, {
    FAKE_CLAUDE_RUNS_LOG: runsLog,
    FAKE_CLAUDE_IDLE_MS: '40000',
    FAKE_CLAUDE_EXIT_WHEN: exitClaude,
    FAKE_CLAUDE_CHATTER_EVERY_MS: '100',
    FAKE_CLAUDE_CHATTER_STAMP: '1',
  });
  return { home, context, runsLog, exitClaude, folder: sessionDirFor(process.pid, ctx) };
}

/** Which account's login is in the session's folder now. */
function onAccount(s: Scene): string | null {
  try {
    return (JSON.parse(readFileSync(path.join(s.folder, '.credentials.json'), 'utf8')) as { account?: string }).account ?? null;
  } catch {
    return null;
  }
}

function events(s: Scene): Array<{ at: number; msg: string }> {
  const file = path.join(s.home, 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { at: number; msg: string });
}

describe.skipIf(!PTY_AVAILABLE && !process.env.CI)('a move in place while Claude holds its locks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const name of [...FAKE_ENV, 'FAKE_CLAUDE_CHATTER_EVERY_MS', 'FAKE_CLAUDE_CHATTER_STAMP', 'FAKE_CLAUDE_EMIT_CAP']) {
      delete process.env[name];
    }
  });

  it("writes nothing until Claude lets go of its login's lock, and never holds up its terminal meanwhile", { timeout: 60_000 }, async () => {
    const s = await scene();
    const lock = path.join(s.folder, CREDENTIALS_LOCK_DIR);
    const relay = watchRelay();
    let tries: ReturnType<typeof watchLockDirTries> | null = null;
    let whileHeld: string | null = null;
    let letGoAt = 0;
    let exit: number;
    try {
      const running = runCommand(s.context, []);
      await until(() => launches(readLog(s.runsLog)).length > 0 && relay.lines().length > 0, 30_000);
      // Claude renewing its login, as it does every few hours.
      mkdirSync(lock);
      tries = watchLockDirTries(lock);
      writeSwitchRequest('B', Date.now(), 'seamless', s.context.ctx, process.pid);
      await sleep(3_000);
      whileHeld = onAccount(s);
      rmSync(lock, { recursive: true, force: true });
      letGoAt = Date.now();
      await until(() => onAccount(s) === 'B', 10_000);
      writeFileSync(s.exitClaude, '');
      exit = await running;
    } finally {
      relay.stop();
      (tries as ReturnType<typeof watchLockDirTries> | null)?.stop();
      rmSync(lock, { recursive: true, force: true });
    }
    expect(whileHeld).toBe('A');
    // Looked at again while held, but never waited for on the thread that relays Claude.
    const tried = (tries as ReturnType<typeof watchLockDirTries> | null)?.tries() ?? [];
    expect(tried.length).toBeGreaterThanOrEqual(2);
    expect(triesWhileALineWaited(relay.lines(), tried)).toBeLessThan(10);
    // Moved once it was let go, in place.
    expect(onAccount(s)).toBe('B');
    const moved = events(s).find((e) => e.msg.startsWith('switching to "B"'));
    expect(moved?.at ?? 0).toBeGreaterThanOrEqual(letGoAt);
    expect(launches(readLog(s.runsLog))).toHaveLength(1);
    expect(exit).toBe(0);
  });

  it('leaves the move waiting while the lock is never let go, says so, and the session stays on its account', { timeout: 60_000 }, async () => {
    const s = await scene();
    s.context.moveLockWaitMs = 1_000;
    const lock = path.join(s.folder, CREDENTIALS_LOCK_DIR);
    const said = (): boolean => events(s).some((e) => e.msg.includes('is waiting: Claude in this session is using its login'));
    let on: string | null = null;
    let pending = false;
    let exit: number;
    try {
      const running = runCommand(s.context, []);
      await until(() => launches(readLog(s.runsLog)).length > 0, 30_000);
      mkdirSync(lock);
      writeSwitchRequest('B', Date.now(), 'seamless', s.context.ctx, process.pid);
      await until(said, 10_000);
      await sleep(500);
      on = onAccount(s);
      pending = readSwitchRequest(s.context.ctx, process.pid) !== null;
      writeFileSync(s.exitClaude, '');
      exit = await running;
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
    expect(on).toBe('A');
    expect(said()).toBe(true);
    // Still asked for, so it is made once the lock goes.
    expect(pending).toBe(true);
    expect(onAccount(s)).toBe('A');
    expect(exit).toBe(0);
  });

  it("writes nothing while Claude holds the lock it takes to save its state", { timeout: 60_000 }, async () => {
    const s = await scene();
    const lock = path.join(s.folder, '.claude.json.lock');
    let whileHeld: string | null = null;
    let exit: number;
    try {
      const running = runCommand(s.context, []);
      await until(() => launches(readLog(s.runsLog)).length > 0, 30_000);
      mkdirSync(lock);
      writeSwitchRequest('B', Date.now(), 'seamless', s.context.ctx, process.pid);
      await sleep(1_500);
      whileHeld = onAccount(s);
      rmSync(lock, { recursive: true, force: true });
      await until(() => onAccount(s) === 'B', 10_000);
      writeFileSync(s.exitClaude, '');
      exit = await running;
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
    expect(whileHeld).toBe('A');
    expect(onAccount(s)).toBe('B');
    expect(exit).toBe(0);
  });

  it('moves a session a limit was met in once Claude lets go, in place, never past the lock', { timeout: 60_000 }, async () => {
    let letGoAt = 0;
    let checks = 0;
    let lock = '';
    const s = await scene(() => {
      checks += 1;
      if (checks > 1) return Promise.resolve('allowed');
      // A is out, and its Claude is renewing its login just then, for 3 s.
      mkdirSync(lock);
      setTimeout(() => {
        rmSync(lock, { recursive: true, force: true });
        letGoAt = Date.now();
      }, 3_000);
      return Promise.resolve('limited');
    });
    lock = path.join(s.folder, CREDENTIALS_LOCK_DIR);
    process.env.FAKE_CLAUDE_EMIT_CAP = '1';
    const relief = (): { at: number } | undefined => events(s).find((e) => e.msg === 'seamless cap relief: A -> B');
    let exit: number;
    try {
      const running = runCommand(s.context, []);
      await until(() => relief() !== undefined, 20_000);
      await until(() => onAccount(s) === 'B', 5_000);
      writeFileSync(s.exitClaude, '');
      exit = await running;
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
    expect(letGoAt).toBeGreaterThan(0);
    expect(relief()?.at ?? 0).toBeGreaterThanOrEqual(letGoAt);
    expect(onAccount(s)).toBe('B');
    expect(launches(readLog(s.runsLog))).toHaveLength(1);
    expect(exit).toBe(0);
  });

  it('relaunches a session a limit was met in when the lock is never let go, rather than move past it', { timeout: 60_000 }, async () => {
    let lock = '';
    let checks = 0;
    const s = await scene(() => {
      checks += 1;
      if (checks > 1) return Promise.resolve('allowed');
      mkdirSync(lock);
      return Promise.resolve('limited');
    });
    s.context.moveLockWaitMs = 1_000;
    lock = path.join(s.folder, CREDENTIALS_LOCK_DIR);
    process.env.FAKE_CLAUDE_EMIT_CAP = '1';
    process.env.FAKE_CLAUDE_RESUMED_IDLE_MS = '600';
    let exit: number;
    const started = Date.now();
    try {
      exit = await runCommand(s.context, []);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
    const runs = launches(readLog(s.runsLog));
    expect(runs).toHaveLength(2);
    // Relaunched once the wait ran out, not when Claude happened to end.
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(runs[1]?.marker).toBe('B');
    expect(events(s).some((e) => e.msg === 'seamless cap relief: A -> B')).toBe(false);
    expect(exit).toBe(0);
  });
});
