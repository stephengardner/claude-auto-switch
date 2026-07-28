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
  // account each launch actually ran on.
  writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }), 'utf8');
}

describe('on-demand switch in a running session (against fake-claude)', () => {
  afterEach(() => {
    delete process.env.FAKE_CLAUDE_IDLE_MS;
    delete process.env.FAKE_CLAUDE_RUNS_LOG;
  });

  it('swaps a live session to the picked account and resumes with --continue', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-switch-live-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_IDLE_MS = '900'; // each launch stays alive ~900ms unless killed
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;

    const context = makeContext(home);
    await loginAccount(context, home, 'A');
    await loginAccount(context, home, 'B');
    setActive('A', context.ctx); // start on A

    // Start the interactive session (no -p => the hot-swap PTY path).
    const running = runCommand(context, []);
    // Mid-session, pick B, exactly what dashboard Enter / `ccx use B` writes.
    await sleep(120);
    writeSwitchRequest('B', Date.now(), context.ctx);

    const exit = await running;
    expect(exit).toBe(0);

    const runs = readFileSync(runsLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { args: string[]; marker: string | null });

    expect(runs).toHaveLength(2);
    const [first, second] = runs;
    expect(first?.marker).toBe('A'); // launched on A first
    expect(first?.args ?? []).not.toContain('--continue');
    expect(second?.marker).toBe('B'); // switched to B in place
    expect(second?.args ?? []).toContain('--continue'); // same conversation continued
  });
});
