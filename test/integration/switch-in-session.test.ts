import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
    delete process.env.FAKE_CLAUDE_EMIT_CAP;
  });

  it('ignores a cap message replayed at startup (no user input): no false cap, no cascade', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-nocascade-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_IDLE_MS = '600';
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;
    process.env.FAKE_CLAUDE_EMIT_CAP = '1'; // the run "replays" a prior cap at startup

    const context = makeContext(home);
    await loginAccount(context, home, 'A');
    await loginAccount(context, home, 'B');
    setActive('A', context.ctx);

    // No user input: the startup cap must be treated as historical, not fresh.
    const exit = await runCommand(context, []);
    expect(exit).toBe(0); // ended normally on A, not "every account is capped" (exit 1)

    const launches = readRuns(runsLog).filter((r) => r.type === 'launch');
    expect(launches).toHaveLength(1); // no rotation -> no cascade
    const ledgerPath = path.join(home, 'ledger.json');
    const caps = existsSync(ledgerPath)
      ? ((JSON.parse(readFileSync(ledgerPath, 'utf8')) as { caps?: unknown[] }).caps ?? [])
      : [];
    expect(caps).toHaveLength(0); // nothing falsely marked capped
  });

  it('seamless (default): swaps the credential file in place, no relaunch', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-seamless-'));
    const runsLog = path.join(home, 'runs.jsonl');
    // A generous idle so the swap poll fires well before the run ends, even under
    // parallel-suite CPU load (keeps this timing test from flaking).
    process.env.FAKE_CLAUDE_IDLE_MS = '2500';
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
    // The seamless swap fired (deterministic: logged to the event stream)...
    const events = readFileSync(path.join(home, 'events.jsonl'), 'utf8');
    expect(events).toContain('switching to B in place');
    // ...and it swapped the credential file to B underneath the running process
    // (the simulated ~30s re-read at run's end sees B), with no restart.
    const lastReread = runs.filter((r) => r.type === 'reread').pop();
    expect(lastReread?.marker).toBe('B');
  });

  it('force-now (restart): relaunches on the picked account with --continue', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-forcenow-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_IDLE_MS = '2500'; // generous margin so the poll fires under load
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
