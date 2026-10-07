import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
 * Whether a session hit a wall is decided by the conversation's own record,
 * not by what is on its screen. A session working ON limits prints limit-shaped
 * words all day, and matching them restarted healthy sessions every few
 * minutes; Claude writes every refused turn into the record with its own codes.
 * These drive real sessions through a pseudo-terminal against the fake claude,
 * which keeps a record where the real one does.
 */

const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));
const CONVERSATION = '55555555-6666-4777-8888-999999999999';

interface RunEntry {
  type: 'launch' | 'reread';
  args?: string[];
  marker: string | null;
}

type Verdict = 'limited' | 'allowed' | 'unknown';

function makeContext(home: string, verifyCap: () => Promise<Verdict>): CliContext {
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  return {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    verifyCap,
    // Reached in about a second instead of minutes, so a session that was
    // going to be moved on words alone would be moved inside the test.
    blockedWatch: { after: 2, spreadMs: 300, minGapMs: 50 },
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

function launchesIn(runsLog: string): RunEntry[] {
  if (!existsSync(runsLog)) return [];
  return readFileSync(runsLog, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as RunEntry)
    .filter((r) => r.type === 'launch');
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
  console.warn(`[skipped] refusal record tests: no pseudo-terminal here (${ptyProblem}).`);

const FAKE_ENV = [
  'FAKE_CLAUDE_IDLE_MS',
  'FAKE_CLAUDE_RUNS_LOG',
  'FAKE_CLAUDE_SESSION_RECORD',
  'FAKE_CLAUDE_TRANSCRIPT',
  'FAKE_CLAUDE_REFUSE_AFTER_MS',
  'FAKE_CLAUDE_CAP_EVERY_MS',
  'FAKE_CLAUDE_CAP_AFTER_MS',
];

describe.skipIf(!PTY_AVAILABLE && !process.env.CI)("a session's own record decides whether it hit a wall", () => {
  afterEach(() => {
    for (const name of FAKE_ENV) delete process.env[name];
  });

  it(
    'never moves a session whose screen fills with limit words while its record shows no refusal',
    { timeout: 60_000 },
    async () => {
      const home = mkdtempSync(path.join(tmpdir(), 'cas-record-words-'));
      const runsLog = path.join(home, 'runs.jsonl');
      Object.assign(process.env, {
        FAKE_CLAUDE_RUNS_LOG: runsLog,
        FAKE_CLAUDE_IDLE_MS: '5000',
        FAKE_CLAUDE_SESSION_RECORD: '1',
        FAKE_CLAUDE_TRANSCRIPT: '1',
        // The banner starts once ccx is reading the record, and keeps coming.
        FAKE_CLAUDE_CAP_AFTER_MS: '2500',
        FAKE_CLAUDE_CAP_EVERY_MS: '100',
      });
      let probes = 0;
      const context = makeContext(home, () => {
        probes += 1;
        return Promise.resolve('limited');
      });
      await loginAccount(context, home, 'A');
      await loginAccount(context, home, 'B');
      setActive('A', context.ctx);

      expect(await runCommand(context, ['--resume', CONVERSATION])).toBe(0);
      // Not moved, not even asked about: the words were never a refusal.
      expect(launchesIn(runsLog)).toHaveLength(1);
      expect(probes).toBe(0);
    },
  );

  it(
    'acts on a refusal in the record with nothing about it on the screen',
    { timeout: 60_000 },
    async () => {
      const home = mkdtempSync(path.join(tmpdir(), 'cas-record-refused-'));
      const runsLog = path.join(home, 'runs.jsonl');
      Object.assign(process.env, {
        FAKE_CLAUDE_RUNS_LOG: runsLog,
        FAKE_CLAUDE_IDLE_MS: '6000',
        FAKE_CLAUDE_SESSION_RECORD: '1',
        FAKE_CLAUDE_TRANSCRIPT: '1',
        FAKE_CLAUDE_REFUSE_AFTER_MS: '2500',
      });
      let probes = 0;
      const context = makeContext(home, () => {
        probes += 1;
        // A is out; B, where it moves, is not.
        return Promise.resolve(probes === 1 ? 'limited' : 'allowed');
      });
      await loginAccount(context, home, 'A');
      await loginAccount(context, home, 'B');
      setActive('A', context.ctx);

      expect(await runCommand(context, ['--resume', CONVERSATION])).toBe(0);
      const launches = launchesIn(runsLog);
      expect(probes).toBeGreaterThanOrEqual(1);
      expect(launches.length).toBeGreaterThanOrEqual(2);
      expect(launches[0]?.marker).toBe('A');
      expect(launches[1]?.marker).toBe('B');
      // The same conversation, and told to carry on (the default).
      const relaunch = launches[1]?.args ?? [];
      expect(relaunch[relaunch.indexOf('--resume') + 1]).toBe(CONVERSATION);
      expect(relaunch.at(-1)).toMatch(/^This session was restarted/);
    },
  );
});
