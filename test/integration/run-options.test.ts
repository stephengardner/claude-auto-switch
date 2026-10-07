import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodePty } from '../../src/util/native-pty.js';
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

// Through the loader every part of ccx uses, so these tests open terminals
// exactly as ccx does, including what it does to make that possible.
const { spawn } = nodePty();
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
// Skipped only on a developer machine without a terminal. In CI a terminal
// that cannot open is a failure: skipping is how an install that could not
// start `claude` at all on macOS still passed.
if (!PTY_AVAILABLE)
  console.warn(`[skipped] run-options tests: no pseudo-terminal here (${ptyProblem}).`);

describe.skipIf(!PTY_AVAILABLE && !process.env.CI)(
  'starting a run the way a handover does (against fake-claude)',
  () => {
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

    it(
      'sends the held message in a new conversation too, and in the one started when there is nothing to resume',
      { timeout: 60_000 },
      async () => {
        const fresh = await setup();
        expect(
          await runCommand(fresh.context, [], { startPrompt: 'now fix the failing tests' }),
        ).toBe(0);
        expect(launches(fresh.runsLog)[0]?.args?.at(-1)).toBe('now fix the failing tests');

        // A brand-new Desktop conversation has no transcript yet: the resume
        // finds nothing, and the message must not go with it.
        const gone = await setup();
        process.env.FAKE_CLAUDE_NOTHING_TO_RESUME = '1';
        try {
          expect(
            await runCommand(gone.context, ['--resume', SOURCE], {
              resumePrompt: 'Carry on where you stopped.',
              startPrompt: 'now fix the failing tests',
            }),
          ).toBe(0);
        } finally {
          delete process.env.FAKE_CLAUDE_NOTHING_TO_RESUME;
        }
        const runs = launches(gone.runsLog);
        expect(runs).toHaveLength(2);
        expect(runs[1]?.args).not.toContain('--resume');
        expect(runs[1]?.args?.at(-1)).toBe('now fix the failing tests');
      },
    );

    it(
      'hands Claude a message that starts with a dash, or is one word, as a message',
      { timeout: 60_000 },
      async () => {
        // Claude reads "-..." as an option and "mcp" as its subcommand: a
        // leading space makes both plain text, which the model never notices.
        const { context, runsLog } = await setup();
        expect(
          await runCommand(context, ['--resume', SOURCE], {
            startPrompt: '- add tests\n- run them',
          }),
        ).toBe(0);
        expect(launches(runsLog)[0]?.args?.at(-1)).toBe(' - add tests\n- run them');
      },
    );

    it('starts on the account it was given, not the active one', { timeout: 60_000 }, async () => {
      const { context, runsLog } = await setup();
      expect(await runCommand(context, [], { account: 'B' })).toBe(0);
      expect(launches(runsLog)[0]?.marker).toBe('B');
    });

    it(
      'refuses an account that does not exist before starting anything',
      { timeout: 60_000 },
      async () => {
        const { context, runsLog, said } = await setup();
        expect(await runCommand(context, [], { account: 'nobody' })).toBe(1);
        expect(launches(runsLog)).toHaveLength(0);
        expect(said.join(' ')).toMatch(/no enabled account named "nobody"/);
      },
    );

    it(
      'refuses an account that is not signed in, rather than start on another unsaid',
      { timeout: 60_000 },
      async () => {
        const { context, runsLog, said } = await setup();
        const dir = path.join(context.ctx.env?.HOME as string, 'profiles', 'B');
        writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({}), 'utf8');
        expect(await runCommand(context, [], { account: 'B' })).toBe(1);
        expect(launches(runsLog)).toHaveLength(0);
        expect(said.join(' ')).toMatch(/"B" is not signed in/);
      },
    );
  },
);
