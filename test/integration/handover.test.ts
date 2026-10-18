import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeTerminal } from './terminal-probe.js';
import { addCommand } from '../../src/commands/add.js';
import { runCommand } from '../../src/commands/run.js';
import { setActive } from '../../src/state/active.js';
import { writeSwitchRequest } from '../../src/state/switch-request.js';
import { loadConfig } from '../../src/config/config.js';
import type { CliContext } from '../../src/context.js';

/**
 * A ccx session runs for hours or days, and an update installed meanwhile used
 * to reach it only when someone closed it. A running session now moves itself
 * to the newer ccx: when Claude has been idle a while, or when it is relaunched
 * anyway. The newer ccx here is a stand-in that records how it was started.
 */

const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));
const CONVERSATION = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function newerCcx(): { cli: string; started: () => string[] | null } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-newer-ccx-'));
  const record = path.join(dir, 'started.json');
  const cli = path.join(dir, 'cli.js');
  writeFileSync(
    cli,
    `require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));`,
  );
  return {
    cli,
    started: () =>
      existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')) as string[]) : null,
  };
}

function makeContext(home: string, cli: string): CliContext {
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  return {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    verifyCap: () => Promise.resolve('allowed'),
    newerInstall: () => ({ version: '9.9.9', cli }),
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

const launches = (runsLog: string): number =>
  existsSync(runsLog)
    ? readFileSync(runsLog, 'utf8')
        .split('\n')
        .filter((l) => l.includes('"type":"launch"')).length
    : 0;

const terminal = probeTerminal();
const PTY_AVAILABLE = terminal.open;
const ptyProblem = terminal.problem;
// Skipped only on a developer machine without a terminal. In CI a terminal
// that cannot open is a failure: skipping is how an install that could not
// start `claude` at all on macOS still passed.
if (!PTY_AVAILABLE && !process.env.CI)
  console.warn(`[skipped] handover tests: no pseudo-terminal here (${ptyProblem}).`);

const FAKE_ENV = [
  'FAKE_CLAUDE_IDLE_MS',
  'FAKE_CLAUDE_RUNS_LOG',
  'FAKE_CLAUDE_SESSION_RECORD',
  'FAKE_CLAUDE_IDLE_STATUS',
  'FAKE_CLAUDE_EMIT_CAP',
];

describe.skipIf(!PTY_AVAILABLE && !process.env.CI)('a running session moves to a newer ccx by itself', () => {
  afterEach(() => {
    for (const name of FAKE_ENV) delete process.env[name];
  });

  it(
    'once Claude has been idle a while: same conversation, same account, nothing said',
    { timeout: 60_000 },
    async () => {
      const home = mkdtempSync(path.join(tmpdir(), 'cas-handover-idle-'));
      const runsLog = path.join(home, 'runs.jsonl');
      Object.assign(process.env, {
        FAKE_CLAUDE_RUNS_LOG: runsLog,
        FAKE_CLAUDE_IDLE_MS: '15000',
        FAKE_CLAUDE_SESSION_RECORD: '1',
        FAKE_CLAUDE_IDLE_STATUS: '1',
      });
      const newer = newerCcx();
      const context = makeContext(home, newer.cli);
      // Left alone for 0.3 s counts, rather than the 20 s ccx waits.
      context.idleBeforeRestartMs = 300;
      await loginAccount(context, home, 'A');
      await loginAccount(context, home, 'B');
      setActive('A', context.ctx);

      expect(await runCommand(context, ['--resume', CONVERSATION])).toBe(0);
      expect(newer.started()).toEqual(['run', '--account', 'A', '--', '--resume', CONVERSATION]);
      // Claude was not started again by this ccx: the newer one does that.
      expect(launches(runsLog)).toBe(1);
    },
  );

  it(
    'writes a limit still waiting for the ledger, and what it logged, before the newer ccx starts',
    { timeout: 60_000 },
    async () => {
      // The newer ccx is started with spawnSync, which holds this thread until
      // it ends: nothing still waiting for a lock would be written by a timer
      // meanwhile. Another process holds the ledger and the event log until
      // this session has given up its account, then lets go.
      const home = mkdtempSync(path.join(tmpdir(), 'cas-handover-held-'));
      const runsLog = path.join(home, 'runs.jsonl');
      Object.assign(process.env, {
        FAKE_CLAUDE_RUNS_LOG: runsLog,
        FAKE_CLAUDE_IDLE_MS: '15000',
        FAKE_CLAUDE_SESSION_RECORD: '1',
        FAKE_CLAUDE_IDLE_STATUS: '1',
        FAKE_CLAUDE_EMIT_CAP: '1',
      });
      // The newer ccx notes what the ledger and the log held as it started.
      const dir = mkdtempSync(path.join(tmpdir(), 'cas-newer-ccx-'));
      const record = path.join(dir, 'found.json');
      const cli = path.join(dir, 'cli.js');
      writeFileSync(
        cli,
        [
          `const fs = require('fs');`,
          `const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');`,
          `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({`,
          `  ledger: read(${JSON.stringify(path.join(home, 'ledger.json'))}),`,
          `  events: read(${JSON.stringify(path.join(home, 'events.jsonl'))}),`,
          `}));`,
        ].join('\n'),
      );
      let probes = 0;
      const context = makeContext(home, cli);
      context.verifyCap = () => Promise.resolve(probes++ === 0 ? 'limited' : 'allowed');
      context.idleBeforeRestartMs = 300;
      context.config.resume.auto = false;
      await loginAccount(context, home, 'A');
      await loginAccount(context, home, 'B');
      setActive('A', context.ctx);

      const holder = spawn(
        process.execPath,
        [
          '-e',
          [
            `const fs = require('node:fs');`,
            `const path = require('node:path');`,
            `const [home, pid] = process.argv.slice(1);`,
            `const locks = [path.join(home, 'ledger.json.lock'), path.join(home, 'events.jsonl.compact.lock')];`,
            `for (const lock of locks) fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });`,
            `fs.writeFileSync(path.join(home, 'holder-held'), '');`,
            `const leases = () => { try { return fs.readdirSync(path.join(home, 'sessions-live')).filter((n) => n.endsWith('__' + pid + '.json')).length; } catch { return 0; } };`,
            `const startedAt = Date.now();`,
            `let seen = false;`,
            `const look = setInterval(() => {`,
            `  if (leases() > 0) seen = true;`,
            `  if (!(seen && leases() === 0) && Date.now() - startedAt < 50000) return;`,
            `  clearInterval(look);`,
            `  setTimeout(() => { for (const lock of locks) fs.rmSync(lock, { force: true }); }, 300);`,
            `}, 20);`,
          ].join('\n'),
          home,
          String(process.pid),
        ],
        { stdio: 'ignore' },
      );
      const exited = new Promise<number | null>((resolve) => holder.on('exit', resolve));
      while (!existsSync(path.join(home, 'holder-held')) && holder.exitCode === null) await sleep(20);

      expect(await runCommand(context, [])).toBe(0);
      expect(await exited).toBe(0);
      const found = existsSync(record)
        ? (JSON.parse(readFileSync(record, 'utf8')) as { ledger: string; events: string })
        : { ledger: '', events: '' };
      // Moved in place off A on its limit, then handed over on B.
      expect(found.events).toContain('seamless cap relief: A -> B');
      const caps = found.ledger ? (JSON.parse(found.ledger) as { caps: Array<{ account: string }> }).caps : [];
      expect(caps.map((c) => c.account)).toEqual(['A']);
      expect(found.events).toContain('moving this session to ccx 9.9.9');
    },
  );

  it(
    'when it relaunches anyway, carrying on as that relaunch would have',
    { timeout: 60_000 },
    async () => {
      const home = mkdtempSync(path.join(tmpdir(), 'cas-handover-swap-'));
      const runsLog = path.join(home, 'runs.jsonl');
      Object.assign(process.env, {
        FAKE_CLAUDE_RUNS_LOG: runsLog,
        FAKE_CLAUDE_IDLE_MS: '8000',
        FAKE_CLAUDE_SESSION_RECORD: '1',
      });
      const newer = newerCcx();
      const context = makeContext(home, newer.cli);
      await loginAccount(context, home, 'A');
      await loginAccount(context, home, 'B');
      setActive('A', context.ctx);

      const run = runCommand(context, ['--resume', CONVERSATION]);
      while (launches(runsLog) === 0) await sleep(50);
      writeSwitchRequest('B', Date.now(), 'restart', context.ctx);
      expect(await run).toBe(0);
      const started = newer.started() ?? [];
      expect(started.slice(0, 3)).toEqual(['run', '--account', 'B']);
      expect(started[started.indexOf('--start-prompt') + 1]).toMatch(/^This session was restarted/);
      expect(started.slice(started.indexOf('--'))).toEqual(['--', '--resume', CONVERSATION]);
      expect(launches(runsLog)).toBe(1);
    },
  );
});
