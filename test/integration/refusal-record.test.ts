import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeTerminal } from './terminal-probe.js';
import { addCommand } from '../../src/commands/add.js';
import { updateAccount } from '../../src/accounts/registry.js';
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

function makeContext(home: string, verifyCap: (text: string) => Promise<Verdict>): CliContext {
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

const terminal = probeTerminal();
const PTY_AVAILABLE = terminal.open;
const ptyProblem = terminal.problem;
// Skipped only on a developer machine without a terminal. In CI a terminal
// that cannot open is a failure: skipping is how an install that could not
// start `claude` at all on macOS still passed.
if (!PTY_AVAILABLE && !process.env.CI)
  console.warn(`[skipped] refusal record tests: no pseudo-terminal here (${ptyProblem}).`);

const FAKE_ENV = [
  'FAKE_CLAUDE_IDLE_MS',
  'FAKE_CLAUDE_RUNS_LOG',
  'FAKE_CLAUDE_SESSION_RECORD',
  'FAKE_CLAUDE_TRANSCRIPT',
  'FAKE_CLAUDE_REFUSE_AFTER_MS',
  'FAKE_CLAUDE_CAP_EVERY_MS',
  'FAKE_CLAUDE_CAP_AFTER_MS',
  'FAKE_CLAUDE_CAP_WORDS',
  'FAKE_CLAUDE_RESUMED_IDLE_MS',
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

  it(
    'never moves onto an account disabled after the session started',
    { timeout: 60_000 },
    async () => {
      // A session read its accounts once, at start, and hours later moved onto
      // one the operator had disabled since; handing over to a newer ccx on it
      // then ended the session. B is next in line here until it is disabled.
      const home = mkdtempSync(path.join(tmpdir(), 'cas-record-disabled-'));
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
        return Promise.resolve(probes === 1 ? 'limited' : 'allowed');
      });
      await loginAccount(context, home, 'A');
      await loginAccount(context, home, 'B');
      await loginAccount(context, home, 'C');
      setActive('A', context.ctx);

      // Disabled while the session runs, before A is refused.
      const disable = setTimeout(() => updateAccount('B', { enabled: false }, context.ctx), 1000);
      try {
        expect(await runCommand(context, ['--resume', CONVERSATION])).toBe(0);
      } finally {
        clearTimeout(disable);
      }
      const launches = launchesIn(runsLog);
      expect(launches[0]?.marker).toBe('A');
      expect(launches[1]?.marker).toBe('C');
      expect(launches.map((l) => l.marker)).not.toContain('B');
    },
  );
});

/**
 * Until the conversation's record can be read, the screen stands in for it:
 * here the fake keeps no record at all, and shows Claude 2.1.302's words again
 * and again. The usage check is told what was on the screen, and says A is
 * out and that B, where the session moves, has room.
 */
describe.skipIf(!PTY_AVAILABLE && !process.env.CI)("Claude 2.1.302's words on a session's screen", () => {
  afterEach(() => {
    for (const name of FAKE_ENV) delete process.env[name];
  });

  async function sessionShowing(prefix: string, words: string): Promise<{ asked: string[]; launches: RunEntry[] }> {
    const home = mkdtempSync(path.join(tmpdir(), prefix));
    const runsLog = path.join(home, 'runs.jsonl');
    Object.assign(process.env, {
      FAKE_CLAUDE_RUNS_LOG: runsLog,
      FAKE_CLAUDE_IDLE_MS: '4000',
      FAKE_CLAUDE_RESUMED_IDLE_MS: '1500',
      FAKE_CLAUDE_CAP_EVERY_MS: '300',
      FAKE_CLAUDE_CAP_WORDS: words,
    });
    const asked: string[] = [];
    const context = makeContext(home, (text) => {
      asked.push(text);
      return Promise.resolve(asked.length === 1 ? 'limited' : 'allowed');
    });
    // Production's: three walls over two minutes, out of this test's reach, so
    // only a check that confirms a limit moves the session.
    delete context.blockedWatch;
    await loginAccount(context, home, 'A');
    await loginAccount(context, home, 'B');
    setActive('A', context.ctx);

    expect(await runCommand(context, [])).toBe(0);
    return { asked, launches: launchesIn(runsLog) };
  }

  it(
    'moves on its words for a limit of the account, once the usage check confirms it',
    { timeout: 60_000 },
    async () => {
      const { asked, launches } = await sessionShowing(
        'cas-screen-hit-',
        "You've hit your limit · resets 9pm (America/New_York)",
      );
      expect(asked).not.toEqual([]);
      expect(launches.map((l) => l.marker)).toEqual(['A', 'B']);
    },
  );

  it(
    'asks nothing about its fast limit, which it meets by going on at standard speed',
    { timeout: 60_000 },
    async () => {
      const { asked, launches } = await sessionShowing(
        'cas-screen-fast-',
        'Fast limit reached and temporarily disabled · resets in 4m 12s',
      );
      expect(asked).toEqual([]);
      expect(launches.map((l) => l.marker)).toEqual(['A']);
    },
  );
});
