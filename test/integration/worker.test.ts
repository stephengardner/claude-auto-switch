import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { addCommand } from '../../src/commands/add.js';
import { runCommand } from '../../src/commands/run.js';
import { workerCommand, WORKER_CARRY_ON, type WorkerIo } from '../../src/commands/worker.js';
import { getActive, setActive } from '../../src/state/active.js';
import { loadConfig } from '../../src/config/config.js';
import { leasePath } from '../../src/session/lease.js';
import { saveLedger } from '../../src/ledger/ledger.js';
import { writeSwitchRequest } from '../../src/state/switch-request.js';
import type { CliContext } from '../../src/context.js';

/**
 * `ccx worker` end to end against the fake claude: a headless run in a session
 * folder of its own, on the account the pick order (or the caller) chose, its
 * answer printed with the accounts that did the work, and, when the account
 * runs out mid-task, the same conversation resumed on the next one with a note
 * to carry on rather than the task started over.
 */

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));
const TSX = path.join(REPO, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

interface Launch {
  type: 'launch';
  args: string[];
  marker: string | null;
  prompt?: string | null;
  via?: 'arg' | 'stdin' | null;
  cwd?: string;
  oauthToken?: string | null;
  entrypoint?: string | null;
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

/** Out on the first probe; every later probe finds room. */
const outOnce = (): (() => Promise<Verdict>) => {
  let probes = 0;
  return () => {
    probes += 1;
    return Promise.resolve(probes === 1 ? 'limited' : 'allowed');
  };
};

/** A refusal recorded 1.2s into each launch, which runs for `idleMs` unless ended first. */
const refusing = (idleMs = 4000): Record<string, string> => ({
  FAKE_CLAUDE_IDLE_MS: String(idleMs),
  FAKE_CLAUDE_SESSION_RECORD: '1',
  FAKE_CLAUDE_TRANSCRIPT: '1',
  FAKE_CLAUDE_REFUSE_AFTER_MS: '1200',
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Every variable a test here sets, put back as it was afterwards. */
const TOUCHED = [
  'FAKE_CLAUDE_IDLE_MS',
  'FAKE_CLAUDE_RUNS_LOG',
  'FAKE_CLAUDE_SESSION_RECORD',
  'FAKE_CLAUDE_TRANSCRIPT',
  'FAKE_CLAUDE_REFUSE_AFTER_MS',
  'FAKE_CLAUDE_REFUSE_AGAIN_AFTER_MS',
  'FAKE_CLAUDE_NOTHING_TO_RESUME',
  'FAKE_CLAUDE_SPLIT_ANSWER',
  'FAKE_CLAUDE_GRANDCHILD',
  'FAKE_CLAUDE_GRANDCHILD_STDIO',
  'FAKE_CLAUDE_IGNORE_TERM',
  'FAKE_CLAUDE_PARTIAL_LINE',
  'FAKE_CLAUDE_REFUSE_ON',
  'FAKE_CLAUDE_REFUSAL_ENDS_RUN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDECODE',
];
const original = Object.fromEntries(TOUCHED.map((name) => [name, process.env[name]]));

const valueAfter = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

describe('ccx worker (against fake-claude)', () => {
  const startedIn = process.cwd();
  afterEach(() => {
    for (const name of TOUCHED) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
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
      // A is out; B, where it moves, is not. (The fake refuses on every
      // launch, B's included; the probe is what says only A is really out.)
      const { context, runsLog } = await setup(['A', 'B'], outOnce());
      Object.assign(process.env, refusing());
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

  it('never glues half an event from a launch that was ended onto the next one', { timeout: 60_000 }, async () => {
    const { context } = await setup(['A', 'B'], outOnce());
    Object.assign(process.env, refusing(), { FAKE_CLAUDE_PARTIAL_LINE: '1' });
    const seen = capture();
    expect(await workerCommand(context, ['hello'], { output: 'stream-json' }, [], seen.io)).toBe(0);
    const lines = seen.out().trim().split('\n');
    // Every line an event a reader can parse.
    const events = lines.map((l) => JSON.parse(l) as { type: string; accounts?: string[] });
    expect(events.map((e) => e.type)).toEqual(['system', 'result', 'ccx']);
    expect(events[2]?.accounts).toEqual(['A', 'B']);
  });

  it('passes the flags after -- to Claude', { timeout: 60_000 }, async () => {
    const { context, runsLog } = await setup(['A']);
    expect(await workerCommand(context, ['hi'], {}, ['--max-turns', '5'], capture().io)).toBe(0);
    expect(valueAfter(launchesIn(runsLog)[0]?.args ?? [], '--max-turns')).toBe('5');
  });

  it('keeps the brief the prompt after a Claude flag that takes many values', { timeout: 60_000 }, async () => {
    // `--allowedTools` takes every operand after it, so a brief placed right
    // after it was read as a second tool, and Claude ran with no prompt.
    const { context, runsLog } = await setup(['A']);
    const seen = capture();
    const passthrough = ['--allowedTools', 'Bash(npm test:*)'];
    expect(await workerCommand(context, ['run the tests'], {}, passthrough, seen.io)).toBe(0);
    const [launch] = launchesIn(runsLog);
    expect(launch?.prompt).toBe('run the tests');
    expect((JSON.parse(seen.out()) as { result: string }).result).toBe('done: run the tests');
  });

  it('does not sign in with a login inherited from the Claude that started it', { timeout: 60_000 }, async () => {
    // An orchestrating Claude runs `ccx worker` through its Bash tool, which
    // passes on Claude's own environment. Claude reads a token there before the
    // credential ccx installed, so the worker would run on the orchestrator's
    // account while ccx believed it was elsewhere.
    const { context, runsLog } = await setup(['A']);
    Object.assign(process.env, {
      CLAUDE_CODE_OAUTH_TOKEN: 'the-orchestrators-token',
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
      CLAUDECODE: '1',
    });
    expect(await workerCommand(context, ['hi'], {}, [], capture().io)).toBe(0);
    const [launch] = launchesIn(runsLog);
    expect(launch?.marker).toBe('A');
    expect(launch?.oauthToken).toBeNull();
    expect(launch?.entrypoint).toBeNull();
  });

  it('keeps a character split between two reads whole', { timeout: 60_000 }, async () => {
    const { context } = await setup(['A']);
    process.env.FAKE_CLAUDE_SPLIT_ANSWER = '1';
    const seen = capture();
    expect(await workerCommand(context, ['café ☕ 日本'], {}, [], seen.io)).toBe(0);
    expect((JSON.parse(seen.out()) as { result: string }).result).toBe('done: café ☕ 日本');
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

  it('still spreads out when its own account runs out', { timeout: 60_000 }, async () => {
    // Pinned to A; when A is out, B is next in the pick order but another
    // session is on it, so the worker goes to C.
    const { context, runsLog } = await setup(['A', 'B', 'C'], outOnce());
    const lease = leasePath('B', context.ctx, process.ppid);
    mkdirSync(path.dirname(lease), { recursive: true });
    writeFileSync(lease, JSON.stringify({ account: 'B', pid: process.ppid, configDir: 'elsewhere', at: Date.now() }));
    Object.assign(process.env, refusing());
    expect(await workerCommand(context, ['hi'], { account: 'A' }, [], capture().io)).toBe(0);
    expect(launchesIn(runsLog).map((l) => l.marker)).toEqual(['A', 'C']);
  });

  it('spreads workers started at the same moment across accounts', { timeout: 90_000 }, async () => {
    // Real separate processes, released together: each used to read the leases
    // before any had written one, and all of them picked the same account.
    const { home, runsLog } = await setup(['A', 'B', 'C']);
    const barrier = path.join(home, 'barrier');
    mkdirSync(barrier, { recursive: true });
    // An ES module, for the waiting at the top level.
    const script = path.join(home, 'spread-worker.mts');
    const workerModule = pathToFileURL(path.join(REPO, 'src', 'commands', 'worker.ts')).href;
    const configModule = pathToFileURL(path.join(REPO, 'src', 'config', 'config.ts')).href;
    writeFileSync(
      script,
      [
        `import { readdirSync, writeFileSync } from 'node:fs';`,
        `import path from 'node:path';`,
        `import { workerCommand } from ${JSON.stringify(workerModule)};`,
        `import { loadConfig } from ${JSON.stringify(configModule)};`,
        `const [home, fake, tag, total] = process.argv.slice(2);`,
        `const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };`,
        `const barrier = path.join(home, 'barrier');`,
        `writeFileSync(path.join(barrier, tag), '');`,
        `while (readdirSync(barrier).length < Number(total)) await new Promise((r) => setTimeout(r, 5));`,
        `let out = '';`,
        `const context = { ctx, config: loadConfig(ctx), claude: { bin: process.execPath, prefixArgs: [fake] },`,
        `  verifyCap: () => Promise.resolve('allowed'), out: () => {}, err: () => {}, json: false, quiet: false };`,
        `const code = await workerCommand(context, ['hi'], {}, [], { stdout: (t) => { out += t; }, stderr: () => {} });`,
        `process.stdout.write(out, () => process.exit(code));`,
      ].join('\n'),
      'utf8',
    );
    const WORKERS = 3;
    const results = await Promise.all(
      Array.from(
        { length: WORKERS },
        (_, w) =>
          new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
            const child = spawn(TSX, [script, home, fakeClaude, `w${w}`, String(WORKERS)], {
              stdio: ['ignore', 'pipe', 'pipe'],
              shell: process.platform === 'win32',
              env: { ...process.env, FAKE_CLAUDE_IDLE_MS: '3000', FAKE_CLAUDE_RUNS_LOG: runsLog },
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (d) => {
              stdout += String(d);
            });
            child.stderr.on('data', (d) => {
              stderr += String(d);
            });
            child.on('exit', (code) => resolve({ code, stdout, stderr }));
          }),
      ),
    );
    expect(results.filter((r) => r.code !== 0).map((r) => r.stderr.slice(0, 1500))).toEqual([]);
    const picked = results.map((r) => (JSON.parse(r.stdout) as { ccx: { accounts: string[] } }).ccx.accounts[0]);
    expect(new Set(picked)).toEqual(new Set(['A', 'B', 'C']));
  });

  it('asks about a refusal that came while another was being checked, rather than dropping it', { timeout: 60_000 }, async () => {
    // The first refusal's check is slow and finds room; the second came while
    // it ran, and is the real one.
    let probes = 0;
    const { context, runsLog } = await setup(['A', 'B'], async () => {
      probes += 1;
      if (probes === 1) {
        await sleep(1800);
        return 'allowed';
      }
      return probes === 2 ? 'limited' : 'allowed';
    });
    Object.assign(process.env, refusing(6000), { FAKE_CLAUDE_REFUSE_AFTER_MS: '800', FAKE_CLAUDE_REFUSE_AGAIN_AFTER_MS: '1600' });
    expect(await workerCommand(context, ['hi'], {}, [], capture().io)).toBe(0);
    expect(launchesIn(runsLog).map((l) => l.marker)).toEqual(['A', 'B']);
  });

  it('stops what Claude started when it moves on', { timeout: 60_000 }, async () => {
    const { home, context } = await setup(['A', 'B'], outOnce());
    const pidFile = path.join(home, 'grandchild.pid');
    Object.assign(process.env, refusing(), { FAKE_CLAUDE_GRANDCHILD: pidFile });
    expect(await workerCommand(context, ['hi'], {}, [], capture().io)).toBe(0);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    for (let i = 0; i < 40 && processAlive(pid); i++) await sleep(250);
    expect(processAlive(pid)).toBe(false);
  });

  it('makes a Claude that ignores being asked to stop', { timeout: 30_000 }, async () => {
    const { context, runsLog } = await setup(['A', 'B'], outOnce());
    Object.assign(process.env, refusing(1500), { FAKE_CLAUDE_IGNORE_TERM: '1' });
    expect(await workerCommand(context, ['hi'], {}, [], capture().io)).toBe(0);
    expect(launchesIn(runsLog).map((l) => l.marker)).toEqual(['A', 'B']);
  });

  it('finishes when Claude has, even while something it started holds its output open', { timeout: 15_000 }, async () => {
    const { home, context } = await setup(['A']);
    Object.assign(process.env, {
      FAKE_CLAUDE_GRANDCHILD: path.join(home, 'grandchild.pid'),
      FAKE_CLAUDE_GRANDCHILD_STDIO: 'inherit',
    });
    const seen = capture();
    expect(await workerCommand(context, ['hi'], {}, [], seen.io)).toBe(0);
    expect((JSON.parse(seen.out()) as { result: string }).result).toBe('done: hi');
  });

  it('counts a move made under a running launch in its report', { timeout: 60_000 }, async () => {
    const { context, runsLog } = await setup(['A', 'B']);
    process.env.FAKE_CLAUDE_IDLE_MS = '3000';
    const seen = capture();
    const running = workerCommand(context, ['hi'], {}, [], seen.io);
    await sleep(800);
    // `ccx use B --session <the worker>`: moved in place, no new launch.
    writeSwitchRequest('B', Date.now(), 'seamless', context.ctx, process.pid);
    expect(await running).toBe(0);
    expect(launchesIn(runsLog)).toHaveLength(1);
    const answer = JSON.parse(seen.out()) as { ccx: { accounts: string[]; moves: number } };
    expect(answer.ccx).toMatchObject({ accounts: ['A', 'B'], moves: 1 });
  });

  it('reports the conversation it ended in when it had to start a new one', { timeout: 60_000 }, async () => {
    // Moved off A, but B could not resume the conversation, so it started a
    // new one: the report names that one, as Claude's own answer does.
    const { context, runsLog } = await setup(['A', 'B'], outOnce());
    Object.assign(process.env, refusing(), { FAKE_CLAUDE_NOTHING_TO_RESUME: '1' });
    const seen = capture();
    expect(await workerCommand(context, ['hi'], {}, [], seen.io)).toBe(0);
    const launches = launchesIn(runsLog);
    const first = valueAfter(launches[0]?.args ?? [], '--session-id');
    const answer = JSON.parse(seen.out()) as { session_id: string; result: string; ccx: { sessionId: string } };
    expect(answer.ccx.sessionId).toBe(answer.session_id);
    expect(answer.ccx.sessionId).not.toBe(first);
    // Started over in the new conversation, brief and all.
    expect(answer.result).toBe('done: hi');
  });

  it('lands on the first account it can, not the one sessions start on, when every account is out', { timeout: 60_000 }, async () => {
    const { context, runsLog } = await setup(['A', 'B']);
    const now = Date.now();
    saveLedger(
      {
        caps: ['A', 'B'].map((account) => ({ account, capUntil: now + 3_600_000, reason: 'test', at: now })),
      },
      context.ctx,
    );
    setActive('B', context.ctx);
    await workerCommand(context, ['hi'], {}, [], capture().io);
    expect(launchesIn(runsLog)[0]?.marker).toBe('A');
  });

  it('moves on when the refused turn ends the run, as it does in print mode', { timeout: 60_000 }, async () => {
    // `claude -p` does not wait at a refusal the way the terminal app does: it
    // ends with an error result. The refusal is read from the record as the
    // run ends, confirmed, and the work goes on elsewhere.
    const { context, runsLog } = await setup(['A', 'B'], outOnce());
    Object.assign(process.env, refusing(), { FAKE_CLAUDE_REFUSE_ON: 'A', FAKE_CLAUDE_REFUSAL_ENDS_RUN: '1' });
    const seen = capture();
    expect(await workerCommand(context, ['hi'], {}, [], seen.io)).toBe(0);
    expect(launchesIn(runsLog).map((l) => l.marker)).toEqual(['A', 'B']);
    const answer = JSON.parse(seen.out()) as { is_error: boolean; result: string; ccx: { accounts: string[] } };
    // The failure A printed is not the answer; B's is.
    expect(answer).toMatchObject({ is_error: false, result: `done: ${WORKER_CARRY_ON}` });
    expect(answer.ccx.accounts).toEqual(['A', 'B']);
  });

  it('fails with the answer Claude gave when every account runs out', { timeout: 60_000 }, async () => {
    const { context } = await setup(['A'], () => Promise.resolve('limited'));
    Object.assign(process.env, refusing(), { FAKE_CLAUDE_REFUSAL_ENDS_RUN: '1' });
    const seen = capture();
    expect(await workerCommand(context, ['hi'], {}, [], seen.io)).toBe(1);
    const answer = JSON.parse(seen.out()) as { is_error: boolean; result: string; ccx: { accounts: string[] } };
    expect(answer.is_error).toBe(true);
    expect(answer.result.length).toBeGreaterThan(0);
    expect(answer.ccx.accounts).toEqual(['A']);
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

  it('refuses what it cannot run, before starting anything, in the shape it was asked for', { timeout: 60_000 }, async () => {
    const { home, context, runsLog, said } = await setup(['A']);
    const refused = capture();
    expect(await workerCommand(context, ['hi'], { account: 'nobody' }, [], refused.io)).toBe(2);
    expect(await workerCommand(context, ['hi'], { output: 'xml' }, [], capture().io)).toBe(2);
    expect(await workerCommand(context, ['  '], {}, [], capture().io)).toBe(2);
    const brief = path.join(home, 'brief.md');
    writeFileSync(brief, 'the task');
    expect(await workerCommand(context, ['hi'], { briefFile: brief }, [], capture().io)).toBe(2);
    expect(launchesIn(runsLog)).toHaveLength(0);
    expect(said.join('\n')).toMatch(/no account named "nobody"/);
    expect(said.join('\n')).toMatch(/--output is one of json, stream-json, text/);
    expect(said.join('\n')).toMatch(/no brief given/);
    expect(said.join('\n')).toMatch(/not both/);
    // A program reading json still gets one object it can parse.
    expect(JSON.parse(refused.out())).toMatchObject({ is_error: true, ccx: { accounts: [], sessionId: null } });
  });

  it('says there is nothing to run on when no account has been added', { timeout: 60_000 }, async () => {
    const { context, said } = await setup([]);
    expect(await workerCommand(context, ['hi'], {}, [], capture().io)).toBe(2);
    expect(said.join('\n')).toMatch(/no accounts registered/);
  });
});
