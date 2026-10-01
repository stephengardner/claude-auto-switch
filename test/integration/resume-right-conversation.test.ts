import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node-pty';
import { addCommand } from '../../src/commands/add.js';
import { runCommand } from '../../src/commands/run.js';
import { setActive } from '../../src/state/active.js';
import { writeSwitchRequest } from '../../src/state/switch-request.js';
import { loadConfig } from '../../src/config/config.js';
import { sessionDirFor } from '../../src/session/session-dir.js';
import type { CliContext } from '../../src/context.js';

/**
 * A swap has to come back to the conversation that is actually on screen.
 *
 * ccx used to know only the id it started with, plus whatever its own status
 * line reported. So a session where the operator ran `/clear` or `/resume`, or
 * one started with `--continue` or the picker, came back from a swap in some
 * other conversation, and when that one was open elsewhere two processes wrote
 * into it. These run the whole session against a fake Claude that keeps the
 * same per-process record the real one does (see fake-claude.mjs).
 */

const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const STARTED = '11111111-2222-4333-8444-555555555555';
const CLEARED = '22222222-3333-4444-8555-666666666666';
const LANDED = '33333333-4444-4555-8666-777777777777';
const SOURCE = '44444444-5555-4666-8777-888888888888';

async function waitFor<T>(
  what: string,
  read: () => T,
  ok: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = read();
  while (Date.now() < deadline) {
    last = read();
    if (ok(last)) return last;
    await sleep(50);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${what}; last saw ${JSON.stringify(last)}`,
  );
}

interface RunEntry {
  type: 'launch' | 'reread';
  args?: string[];
  marker: string | null;
}

function readLaunches(runsLog: string): RunEntry[] {
  try {
    return readFileSync(runsLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as RunEntry)
      .filter((r) => r.type === 'launch');
  } catch {
    return []; // the log does not exist until the fake writes its first line
  }
}

function makeContext(home: string): CliContext {
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  return {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    verifyCap: () => Promise.resolve('allowed'),
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
  };
}

async function loginAccount(context: CliContext, home: string, name: string): Promise<void> {
  const dir = path.join(home, 'profiles', name);
  await addCommand(context, name, { dir, login: false });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }), 'utf8');
}

/** What ccx has recorded as this run's conversation. */
function recorded(context: CliContext): string | null {
  try {
    const report = JSON.parse(
      readFileSync(
        path.join(sessionDirFor(process.pid, context.ctx), 'claude-report.json'),
        'utf8',
      ),
    ) as { id?: string };
    return report.id ?? null;
  } catch {
    return null;
  }
}

function valueAfter(args: string[] | undefined, flag: string): string | null {
  const list = args ?? [];
  const i = list.indexOf(flag);
  return i >= 0 ? (list[i + 1] ?? null) : null;
}

let ptyProblem = '';
function canSpawnPty(): boolean {
  try {
    const probe = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });
    try {
      probe.kill();
    } catch {
      /* already gone */
    }
    return true;
  } catch (err) {
    ptyProblem = (err as Error).message;
    return false;
  }
}

const PTY_AVAILABLE = canSpawnPty();
if (!PTY_AVAILABLE) {
  console.warn(
    `[skipped] resume-the-right-conversation tests: this machine would not open a terminal (${ptyProblem}).`,
  );
}

/**
 * Start a run on account A, wait until it is up and ccx has learned `expected`
 * as its conversation, then ask for a restart onto B, which is a relaunch that
 * has to resume the conversation by id.
 */
async function swapOnceLearned(
  args: string[],
  expected: string,
): Promise<{ exit: number; launches: RunEntry[] }> {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-right-conv-'));
  const runsLog = path.join(home, 'runs.jsonl');
  process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;
  process.env.FAKE_CLAUDE_IDLE_MS = '4000';
  process.env.FAKE_CLAUDE_SESSION_RECORD = '1';
  const context = makeContext(home);
  await loginAccount(context, home, 'A');
  await loginAccount(context, home, 'B');
  setActive('A', context.ctx);

  const run = runCommand(context, args);
  await waitFor(
    'the first launch',
    () => readLaunches(runsLog),
    (l) => l.length > 0,
  );
  await waitFor(
    `ccx to learn conversation ${expected}`,
    () => recorded(context),
    (id) => id === expected,
  );
  writeSwitchRequest('B', Date.now(), 'restart', context.ctx);
  const exit = await run;
  return { exit, launches: readLaunches(runsLog) };
}

describe.skipIf(!PTY_AVAILABLE)(
  'a swap resumes the conversation on screen (against fake-claude)',
  () => {
    afterEach(() => {
      for (const key of [
        'FAKE_CLAUDE_RUNS_LOG',
        'FAKE_CLAUDE_IDLE_MS',
        'FAKE_CLAUDE_SESSION_RECORD',
        'FAKE_CLAUDE_SWITCH_TO',
        'FAKE_CLAUDE_SWITCH_AFTER_MS',
        'FAKE_CLAUDE_LANDS_ON',
        'FAKE_CLAUDE_NOTHING_TO_RESUME',
      ]) {
        delete process.env[key];
      }
    });

    it(
      'after /clear, resumes the NEW conversation, not the one the run started in',
      { timeout: 60_000 },
      async () => {
        process.env.FAKE_CLAUDE_SWITCH_TO = CLEARED;
        process.env.FAKE_CLAUDE_SWITCH_AFTER_MS = '300';
        const { exit, launches } = await swapOnceLearned(['--session-id', STARTED], CLEARED);
        expect(exit).toBe(0);
        expect(launches.length).toBeGreaterThanOrEqual(2);
        expect(valueAfter(launches[0]?.args, '--session-id')).toBe(STARTED);
        expect(launches[0]?.marker).toBe('A');
        expect(launches[1]?.marker).toBe('B');
        expect(valueAfter(launches[1]?.args, '--resume')).toBe(CLEARED);
      },
    );

    it(
      'a run started with --continue resumes what Claude landed on BY ID, not "the most recent here"',
      { timeout: 60_000 },
      async () => {
        // ccx cannot know before starting which conversation --continue picks. The
        // relaunch used to repeat --continue, which is a different thread whenever
        // another session in the folder was used more recently.
        process.env.FAKE_CLAUDE_LANDS_ON = LANDED;
        const { exit, launches } = await swapOnceLearned(['--continue'], LANDED);
        expect(exit).toBe(0);
        expect(launches[1]?.args).not.toContain('--continue');
        expect(valueAfter(launches[1]?.args, '--resume')).toBe(LANDED);
      },
    );

    it(
      'names a fork up front, and a swap resumes the fork without forking again',
      { timeout: 60_000 },
      async () => {
        // A relaunch that kept --fork-session copied the conversation again on
        // every swap, and one that resumed the SOURCE id dropped all the work done
        // in the copy.
        const home = mkdtempSync(path.join(tmpdir(), 'cas-right-conv-fork-'));
        const runsLog = path.join(home, 'runs.jsonl');
        process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;
        process.env.FAKE_CLAUDE_IDLE_MS = '4000';
        process.env.FAKE_CLAUDE_SESSION_RECORD = '1';
        const context = makeContext(home);
        await loginAccount(context, home, 'A');
        await loginAccount(context, home, 'B');
        setActive('A', context.ctx);

        const run = runCommand(context, ['--resume', SOURCE, '--fork-session']);
        const [first] = await waitFor(
          'the first launch',
          () => readLaunches(runsLog),
          (l) => l.length > 0,
        );
        const fork = valueAfter(first?.args, '--session-id');
        expect(first?.args).toContain('--fork-session');
        expect(fork).not.toBeNull();
        expect(fork).not.toBe(SOURCE);
        await waitFor(
          'ccx to learn the fork',
          () => recorded(context),
          (id) => id === fork,
        );
        writeSwitchRequest('B', Date.now(), 'restart', context.ctx);
        expect(await run).toBe(0);

        const second = readLaunches(runsLog)[1];
        expect(second?.args).not.toContain('--fork-session');
        expect(second?.args).not.toContain(SOURCE);
        expect(valueAfter(second?.args, '--resume')).toBe(fork);
      },
    );

    it(
      'a swap before the first message starts fresh instead of ending the session',
      { timeout: 60_000 },
      async () => {
        // Nothing is on disk for a conversation until its first message, so the
        // relaunch's --resume finds nothing. Claude says so and exits 1, in words
        // ccx did not recognise, and the run ended there.
        const home = mkdtempSync(path.join(tmpdir(), 'cas-right-conv-empty-'));
        const runsLog = path.join(home, 'runs.jsonl');
        process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;
        process.env.FAKE_CLAUDE_IDLE_MS = '3000';
        process.env.FAKE_CLAUDE_SESSION_RECORD = '1';
        process.env.FAKE_CLAUDE_NOTHING_TO_RESUME = '1';
        const context = makeContext(home);
        await loginAccount(context, home, 'A');
        await loginAccount(context, home, 'B');
        setActive('A', context.ctx);

        const run = runCommand(context, []);
        const [first] = await waitFor(
          'the first launch',
          () => readLaunches(runsLog),
          (l) => l.length > 0,
        );
        const started = valueAfter(first?.args, '--session-id');
        expect(started).not.toBeNull();
        writeSwitchRequest('B', Date.now(), 'restart', context.ctx);
        expect(await run).toBe(0);

        const launches = readLaunches(runsLog);
        expect(launches).toHaveLength(3);
        expect(valueAfter(launches[1]?.args, '--resume')).toBe(started);
        const fresh = launches[2]?.args;
        expect(fresh).not.toContain('--resume');
        expect(valueAfter(fresh, '--session-id')).not.toBeNull();
        expect(valueAfter(fresh, '--session-id')).not.toBe(started);
        expect(launches[2]?.marker).toBe('B');
      },
    );
  },
);
