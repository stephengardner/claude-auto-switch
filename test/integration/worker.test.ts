import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCommand } from '../../src/commands/add.js';
import { runCommand } from '../../src/commands/run.js';
import { workerCommand, WORKER_CARRY_ON, type WorkerIo } from '../../src/commands/worker.js';
import { getActive, setActive } from '../../src/state/active.js';
import { loadConfig } from '../../src/config/config.js';
import { leasePath } from '../../src/session/lease.js';
import type { CliContext } from '../../src/context.js';

/**
 * `ccx worker` end to end against the fake claude: a headless run in a session
 * folder of its own, on the account the pick order (or the caller) chose, its
 * answer printed with the accounts that did the work, and, when the account
 * runs out mid-task, the same conversation resumed on the next one with a note
 * to carry on rather than the task started over.
 */

const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));

interface Launch {
  type: 'launch';
  args: string[];
  marker: string | null;
  prompt?: string | null;
  via?: 'arg' | 'stdin' | null;
  cwd?: string;
}

type Verdict = 'limited' | 'allowed' | 'unknown';

function makeContext(home: string, verifyCap: () => Promise<Verdict>, said: string[]): CliContext {
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  return {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    verifyCap,
    out: (m) => said.push(m),
    err: (m) => said.push(m),
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

function launchesIn(runsLog: string): Launch[] {
  if (!existsSync(runsLog)) return [];
  return readFileSync(runsLog, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Launch)
    .filter((r) => r.type === 'launch');
}

function capture(): { io: WorkerIo; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
    },
    out: () => out,
    err: () => err,
  };
}

async function setup(
  names: string[],
  verifyCap: () => Promise<Verdict> = () => Promise.resolve('allowed'),
): Promise<{ home: string; context: CliContext; runsLog: string; said: string[] }> {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-worker-'));
  const runsLog = path.join(home, 'runs.jsonl');
  process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;
  const said: string[] = [];
  const context = makeContext(home, verifyCap, said);
  for (const name of names) await loginAccount(context, home, name);
  return { home, context, runsLog, said };
}

const FAKE_ENV = [
  'FAKE_CLAUDE_IDLE_MS',
  'FAKE_CLAUDE_RUNS_LOG',
  'FAKE_CLAUDE_SESSION_RECORD',
  'FAKE_CLAUDE_TRANSCRIPT',
  'FAKE_CLAUDE_REFUSE_AFTER_MS',
];

const valueAfter = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

describe('ccx worker (against fake-claude)', () => {
  const startedIn = process.cwd();
  afterEach(() => {
    for (const name of FAKE_ENV) delete process.env[name];
    process.chdir(startedIn);
  });

  it("runs the brief headless and prints Claude's answer with the accounts that did it", { timeout: 60_000 }, async () => {
    const { context, runsLog } = await setup(['A', 'B']);
    const seen = capture();
    expect(await workerCommand(context, ['write', 'the', 'tests'], { agent: 'coder' }, [], seen.io)).toBe(0);

    const answer = JSON.parse(seen.out()) as { result: string; session_id: string; ccx: Record<string, unknown> };
    expect(answer.result).toBe('done: write the tests');
    expect(answer.ccx).toEqual({ accounts: ['A'], moves: 0, sessionId: answer.session_id });

    const [launch] = launchesIn(runsLog);
    expect(launch?.marker).toBe('A');
    expect(launch?.args.slice(0, 3)).toEqual(['-p', '--output-format', 'json']);
    expect(valueAfter(launch?.args ?? [], '--agent')).toBe('coder');
    expect(valueAfter(launch?.args ?? [], '--session-id')).toBe(answer.session_id);
    expect(launch?.prompt).toBe('write the tests');
  });

  it(
    'resumes the same conversation on the next account when one runs out, carrying on rather than starting over',
    { timeout: 60_000 },
    async () => {
      let probes = 0;
      // A is out; B, where it moves, is not.
      const { context, runsLog } = await setup(['A', 'B'], () => {
        probes += 1;
        return Promise.resolve(probes === 1 ? 'limited' : 'allowed');
      });
      Object.assign(process.env, {
        FAKE_CLAUDE_IDLE_MS: '4000',
        FAKE_CLAUDE_SESSION_RECORD: '1',
        FAKE_CLAUDE_TRANSCRIPT: '1',
        FAKE_CLAUDE_REFUSE_AFTER_MS: '1200',
      });
      const seen = capture();
      expect(await workerCommand(context, ['refactor', 'billing'], {}, [], seen.io)).toBe(0);

      const launches = launchesIn(runsLog);
      expect(launches.map((l) => l.marker)).toEqual(['A', 'B']);
      const id = valueAfter(launches[0]?.args ?? [], '--session-id');
      expect(id).toBeDefined();
      // The same conversation, told to carry on: not the brief again.
      expect(valueAfter(launches[1]?.args ?? [], '--resume')).toBe(id);
      expect(launches[1]?.prompt).toBe(WORKER_CARRY_ON);
      expect(launches[1]?.args).toContain('-p');

      // Only the launch that finished is printed, and the report says where it ran.
      const answer = JSON.parse(seen.out()) as { result: string; ccx: { accounts: string[]; moves: number } };
      expect(answer.result).toBe(`done: ${WORKER_CARRY_ON}`);
      expect(answer.ccx.accounts).toEqual(['A', 'B']);
      expect(answer.ccx.moves).toBe(1);
    },
  );

  it('sends a brief too long for a command line by standard input', { timeout: 60_000 }, async () => {
    const { context, runsLog } = await setup(['A']);
    const brief = `${'spec line\n'.repeat(1600)}end`;
    const seen = capture();
    expect(await workerCommand(context, [brief], {}, [], seen.io)).toBe(0);
    const [launch] = launchesIn(runsLog);
    expect(launch?.via).toBe('stdin');
    expect(launch?.prompt).toBe(brief);
    expect(launch?.args).not.toContain(brief);
  });

  it('prints plain text with its report on standard error', { timeout: 60_000 }, async () => {
    const { context } = await setup(['A']);
    const seen = capture();
    expect(await workerCommand(context, ['hello'], { output: 'text' }, [], seen.io)).toBe(0);
    expect(seen.out()).toBe('done: hello\n');
    expect(seen.err()).toMatch(/\[ccx\] worker ran on A \(session [0-9a-f-]{36}\)/);
  });

  it('streams stream-json as it arrives, and ends with its report', { timeout: 60_000 }, async () => {
    const { context, runsLog } = await setup(['A']);
    const seen = capture();
    expect(await workerCommand(context, ['hello'], { output: 'stream-json' }, [], seen.io)).toBe(0);
    const lines = seen
      .out()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; accounts?: string[] });
    expect(lines.map((l) => l.type)).toEqual(['system', 'result', 'ccx']);
    expect(lines[2]?.accounts).toEqual(['A']);
    // Claude needs --verbose for stream-json in print mode.
    expect(launchesIn(runsLog)[0]?.args).toContain('--verbose');
  });

  it('passes the flags after -- to Claude', { timeout: 60_000 }, async () => {
    const { context, runsLog } = await setup(['A']);
    expect(await workerCommand(context, ['hi'], {}, ['--max-turns', '5'], capture().io)).toBe(0);
    expect(valueAfter(launchesIn(runsLog)[0]?.args ?? [], '--max-turns')).toBe('5');
  });

  it('never moves the account other sessions start on', { timeout: 60_000 }, async () => {
    const { context } = await setup(['A', 'B']);
    setActive('A', context.ctx);
    expect(await workerCommand(context, ['hi'], { account: 'B' }, [], capture().io)).toBe(0);
    expect(getActive(context.ctx)).toBe('A');
  });

  it('prefers a healthy account no other session is using', { timeout: 60_000 }, async () => {
    const { context, runsLog } = await setup(['A', 'B']);
    // Another live session (the test runner's parent is certainly alive) on A.
    const lease = leasePath('A', context.ctx, process.ppid);
    mkdirSync(path.dirname(lease), { recursive: true });
    writeFileSync(lease, JSON.stringify({ account: 'A', pid: process.ppid, configDir: 'elsewhere', at: Date.now() }));
    expect(await workerCommand(context, ['hi'], {}, [], capture().io)).toBe(0);
    expect(launchesIn(runsLog)[0]?.marker).toBe('B');
  });

  it('works in the folder it was given', { timeout: 60_000 }, async () => {
    const { home, context, runsLog } = await setup(['A']);
    const tree = path.join(home, 'worktree');
    mkdirSync(tree, { recursive: true });
    expect(await workerCommand(context, ['hi'], { cwd: tree }, [], capture().io)).toBe(0);
    expect(realpathSync(launchesIn(runsLog)[0]?.cwd ?? '')).toBe(realpathSync(tree));
  });

  it('lets a plain headless ccx run start on the account it names, too', { timeout: 60_000 }, async () => {
    const { home, context, runsLog, said } = await setup(['A', 'B']);
    for (const name of ['A', 'B']) {
      writeFileSync(
        path.join(home, 'profiles', name, 'fake-scenario.json'),
        JSON.stringify({ authStatus: { loggedIn: true, authMethod: 'claude.ai', email: `${name}@example.com` } }),
      );
    }
    setActive('A', context.ctx);
    expect(await runCommand(context, ['-p', 'hi'], { account: 'B' })).toBe(0);
    expect(launchesIn(runsLog)[0]?.marker).toBe('B');
    expect(said.join('\n')).not.toMatch(/ignored for this run/);
  });

  it('refuses what it cannot run, before starting anything', { timeout: 60_000 }, async () => {
    const { context, runsLog, said } = await setup(['A']);
    expect(await workerCommand(context, ['hi'], { account: 'nobody' }, [], capture().io)).toBe(2);
    expect(await workerCommand(context, ['hi'], { output: 'xml' }, [], capture().io)).toBe(2);
    expect(await workerCommand(context, ['  '], {}, [], capture().io)).toBe(2);
    expect(launchesIn(runsLog)).toHaveLength(0);
    expect(said.join('\n')).toMatch(/no account named "nobody"/);
    expect(said.join('\n')).toMatch(/--output is one of json, stream-json, text/);
    expect(said.join('\n')).toMatch(/no brief given/);
  });
});
