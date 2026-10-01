import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node-pty';
import { addCommand } from '../../src/commands/add.js';
import { runCommand } from '../../src/commands/run.js';
import { setActive } from '../../src/state/active.js';
import { loadConfig } from '../../src/config/config.js';
import type { CliContext } from '../../src/context.js';

/**
 * The run options a Claude Desktop conversation is handed over with: start on
 * a chosen account, and send the message Desktop held back before anything
 * else, while the armed prompt waits for the swaps after.
 */

const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));
const SOURCE = '44444444-5555-4666-8777-888888888888';

interface RunEntry {
  type: string;
  args?: string[];
  marker: string | null;
}

function launches(runsLog: string): RunEntry[] {
  try {
    return readFileSync(runsLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as RunEntry)
      .filter((r) => r.type === 'launch');
  } catch {
    return [];
  }
}

async function setup(): Promise<{ context: CliContext; runsLog: string; said: string[] }> {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-run-options-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  const said: string[] = [];
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    verifyCap: () => Promise.resolve('allowed'),
    out: (m) => said.push(m),
    err: (m) => said.push(m),
    json: false,
    quiet: false,
  };
  for (const name of ['A', 'B']) {
    const dir = path.join(home, 'profiles', name);
    await addCommand(context, name, { dir, login: false });
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }), 'utf8');
  }
  setActive('A', ctx);
  const runsLog = path.join(home, 'runs.jsonl');
  process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;
  process.env.FAKE_CLAUDE_IDLE_MS = '300';
  return { context, runsLog, said };
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
if (!PTY_AVAILABLE) console.warn(`[skipped] run-options tests: no pseudo-terminal here (${ptyProblem}).`);

describe.skipIf(!PTY_AVAILABLE)('starting a run the way a handover does (against fake-claude)', () => {
  afterEach(() => {
    delete process.env.FAKE_CLAUDE_RUNS_LOG;
    delete process.env.FAKE_CLAUDE_IDLE_MS;
  });

  it('sends the held message first, not the armed prompt', { timeout: 60_000 }, async () => {
    const { context, runsLog } = await setup();
    expect(
      await runCommand(context, ['--resume', SOURCE], {
        resumePrompt: 'Carry on where you stopped.',
        startPrompt: 'now fix the failing tests',
      }),
    ).toBe(0);
    expect(launches(runsLog)[0]?.args).toEqual(['--resume', SOURCE, 'now fix the failing tests']);
  });

  it('starts on the account it was given, not the active one', { timeout: 60_000 }, async () => {
    const { context, runsLog } = await setup();
    expect(await runCommand(context, [], { account: 'B' })).toBe(0);
    expect(launches(runsLog)[0]?.marker).toBe('B');
  });

  it('refuses an account that does not exist before starting anything', { timeout: 60_000 }, async () => {
    const { context, runsLog, said } = await setup();
    expect(await runCommand(context, [], { account: 'nobody' })).toBe(1);
    expect(launches(runsLog)).toHaveLength(0);
    expect(said.join(' ')).toMatch(/no enabled account named "nobody"/);
  });
});
