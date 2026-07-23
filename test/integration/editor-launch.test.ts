import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCommand } from '../../src/commands/add.js';
import { useCommand } from '../../src/commands/use.js';
import { editorLaunch } from '../../src/commands/editor-launch.js';
import { loadConfig } from '../../src/config/config.js';
import { getActive } from '../../src/state/active.js';
import { loadLedger } from '../../src/ledger/ledger.js';
import type { CliContext } from '../../src/context.js';

const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));

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

function seed(dir: string, opts: { capped?: boolean } = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.credentials.json'), '{}', 'utf8'); // makes hasLogin true
  writeFileSync(
    path.join(dir, 'fake-scenario.json'),
    JSON.stringify({
      authStatus: { loggedIn: true, subscriptionType: 'max', email: 'x@y.com' },
      capped: opts.capped ?? false,
      capMessage: "You've reached your Fable 5 limit. Run /usage-credits to continue.",
      capExitCode: 1,
    }),
    'utf8',
  );
}

describe('editorLaunch (against fake-claude)', () => {
  it('runs on the active account and, on a cap, flips active to the next healthy one', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-editor-'));
    const context = makeContext(home);
    const dirA = path.join(home, 'profiles', 'A');
    const dirB = path.join(home, 'profiles', 'B');
    await addCommand(context, 'A', { dir: dirA, login: false });
    await addCommand(context, 'B', { dir: dirB, login: false });
    seed(dirA, { capped: true }); // active account will hit its limit
    seed(dirB, { capped: false });
    useCommand(context, 'A');

    const exit = await editorLaunch(context, ['chat']);
    expect(exit).toBe(1); // the capped run's exit code passes through

    // A is recorded capped, and the active account has flipped to B for next time.
    expect(loadLedger(context.ctx).caps.map((c) => c.account)).toContain('A');
    expect(getActive(context.ctx)).toBe('B');
  });

  it('runs on the active account normally when it is not capped', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-editor-'));
    const context = makeContext(home);
    const dirA = path.join(home, 'profiles', 'A');
    await addCommand(context, 'A', { dir: dirA, login: false });
    seed(dirA, { capped: false });
    useCommand(context, 'A');

    expect(await editorLaunch(context, ['chat'])).toBe(0);
    expect(getActive(context.ctx)).toBe('A'); // unchanged
    expect(loadLedger(context.ctx).caps).toHaveLength(0);
  });
});
