import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCommand } from '../../src/commands/add.js';
import { runCommand } from '../../src/commands/run.js';
import { setActive } from '../../src/state/active.js';
import { loadConfig } from '../../src/config/config.js';
import type { CliContext } from '../../src/context.js';

const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));

/**
 * The reported failure, end to end.
 *
 * A scheduled task ran every ten minutes against an account whose Fable was
 * spent. Every probe refused to confirm a cap, because the limit named a model
 * ccx did not believe the session was running. ccx logged six reasons not to
 * act and never moved, while other accounts had Fable to spare.
 *
 * Everything below the rotation was already correct: the ledger, the planner,
 * the operator's model-first preference. What was missing was anything willing
 * to say the session was stuck when no probe would confirm why.
 */
describe('a session stuck on an account nobody can explain', () => {
  afterEach(() => {
    delete process.env.FAKE_CLAUDE_CAP_EVERY_MS;
    delete process.env.FAKE_CLAUDE_IDLE_MS;
    delete process.env.FAKE_CLAUDE_RUNS_LOG;
  });

  interface RunEntry {
    type: string;
    args?: string[];
    marker: string | null;
  }

  function context(home: string): CliContext {
    const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
    return {
      ctx,
      config: loadConfig(ctx),
      claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
      // The API insists the account has room, every single time. This is the
      // production shape: nothing downstream will ever confirm a cap.
      verifyCap: () => Promise.resolve('allowed' as const),
      // Reached in seconds; production needs three walls over two minutes.
      blockedWatch: { after: 2, spreadMs: 300, minGapMs: 100 },
      out: () => {},
      err: () => {},
      json: false,
      quiet: true,
    };
  }

  async function account(ctx: CliContext, home: string, name: string): Promise<void> {
    const dir = path.join(home, 'profiles', name);
    await addCommand(ctx, name, { dir, login: false });
    mkdirSync(dir, { recursive: true });
    // The marker identifies which account each launch actually ran as.
    writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }), 'utf8');
  }

  it('sat there forever before this, which is what was reported', async () => {
    // The control. With the blocked threshold out of reach, this is exactly
    // what shipped: the wall keeps arriving, every probe refutes it, and the
    // session never leaves the account. If this ever starts passing by moving,
    // the test above has stopped proving anything.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-stuck-old-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;
    process.env.FAKE_CLAUDE_CAP_EVERY_MS = '150';
    process.env.FAKE_CLAUDE_IDLE_MS = '2500';

    const ctx = context(home);
    ctx.blockedWatch = { after: Number.MAX_SAFE_INTEGER };
    await account(ctx, home, 'stuck');
    await account(ctx, home, 'roomy');
    setActive('stuck', ctx.ctx);

    await runCommand(ctx, []);

    const launches = (readFileSync(runsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as RunEntry))
      .filter((r) => r.type === 'launch');
    expect(launches.map((r) => r.marker)).not.toContain('roomy');
  }, 40_000);
  it('moves to another account, though every probe says it has room', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-stuck-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;
    process.env.FAKE_CLAUDE_CAP_EVERY_MS = '150';
    process.env.FAKE_CLAUDE_IDLE_MS = '20000';

    const ctx = context(home);
    await account(ctx, home, 'stuck');
    await account(ctx, home, 'roomy');
    setActive('stuck', ctx.ctx);

    await runCommand(ctx, []);

    const launches = (readFileSync(runsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as RunEntry))
      .filter((r) => r.type === 'launch');
    const accounts = launches.map((r) => r.marker);

    // It started where it was told to, and did NOT stay there.
    expect(accounts[0]).toBe('stuck');
    expect(accounts).toContain('roomy');
  }, 40_000);
});
