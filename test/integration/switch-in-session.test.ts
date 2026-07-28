import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCommand } from '../../src/commands/add.js';
import { runCommand } from '../../src/commands/run.js';
import { setActive } from '../../src/state/active.js';
import { writeSwitchRequest } from '../../src/state/switch-request.js';
import { loadConfig } from '../../src/config/config.js';
import type { CliContext } from '../../src/context.js';

const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RunEntry {
  type: 'launch' | 'reread';
  args?: string[];
  marker: string | null;
}

function makeContext(home: string): CliContext {
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  return {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
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
  // A credential file makes the account "usable"; its marker identifies which
  // account each launch (and each simulated re-read) actually saw.
  writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }), 'utf8');
}

function readRuns(runsLog: string): RunEntry[] {
  return readFileSync(runsLog, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as RunEntry);
}

describe('on-demand switch in a running session (against fake-claude)', () => {
  afterEach(() => {
    delete process.env.FAKE_CLAUDE_IDLE_MS;
    delete process.env.FAKE_CLAUDE_RUNS_LOG;
  });

  it('seamless (default): swaps the credential file in place, no relaunch', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-seamless-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_IDLE_MS = '900';
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;

    const context = makeContext(home);
    await loginAccount(context, home, 'A');
    await loginAccount(context, home, 'B');
    setActive('A', context.ctx);

    const running = runCommand(context, []);
    await sleep(120);
    writeSwitchRequest('B', Date.now(), 'seamless', context.ctx);
    expect(await running).toBe(0);

    const runs = readRuns(runsLog);
    const launches = runs.filter((r) => r.type === 'launch');
    expect(launches).toHaveLength(1); // NO relaunch: same process throughout
    expect(launches[0]?.marker).toBe('A'); // launched on A
    // The credential file was swapped to B underneath the running process: the
    // simulated re-read at run's end sees B, without any restart.
    const lastReread = runs.filter((r) => r.type === 'reread').pop();
    expect(lastReread?.marker).toBe('B');
  });

  it('force-now (restart): relaunches on the picked account with --continue', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-forcenow-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_IDLE_MS = '900';
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;

    const context = makeContext(home);
    await loginAccount(context, home, 'A');
    await loginAccount(context, home, 'B');
    setActive('A', context.ctx);

    const running = runCommand(context, []);
    await sleep(120);
    writeSwitchRequest('B', Date.now(), 'restart', context.ctx);
    expect(await running).toBe(0);

    const launches = readRuns(runsLog).filter((r) => r.type === 'launch');
    expect(launches).toHaveLength(2); // ended and relaunched
    expect(launches[0]?.marker).toBe('A');
    expect(launches[0]?.args).not.toContain('--continue');
    expect(launches[1]?.marker).toBe('B'); // relaunched on B
    expect(launches[1]?.args).toContain('--continue'); // same conversation continued
  });
});
