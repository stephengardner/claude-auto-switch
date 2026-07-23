import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCommand } from '../../src/commands/add.js';
import { useCommand } from '../../src/commands/use.js';
import { wrapperLaunch } from '../../src/commands/editor-launch.js';
import { loadConfig } from '../../src/config/config.js';
import { getActive } from '../../src/state/active.js';
import { loadLedger } from '../../src/ledger/ledger.js';
import type { CliContext } from '../../src/context.js';

// The "command" the editor would hand the wrapper: node running the fake claude.
const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));

function makeContext(home: string): CliContext {
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  return {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] }, // health probes use the fake
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
  };
}

function seed(dir: string, capped: boolean): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.credentials.json'), '{}', 'utf8');
  writeFileSync(
    path.join(dir, 'fake-scenario.json'),
    JSON.stringify({
      authStatus: { loggedIn: true, subscriptionType: 'max', email: 'x@y.com' },
      capped,
      capMessage: "You've reached your Fable 5 limit. Run /usage-credits to continue.",
      capExitCode: 1,
    }),
    'utf8',
  );
}

describe('wrapperLaunch (runs the editor-supplied command on the active account)', () => {
  it('runs the command with the active account config dir injected', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-wrap-'));
    const context = makeContext(home);
    const dirA = path.join(home, 'profiles', 'A');
    await addCommand(context, 'A', { dir: dirA, login: false });
    seed(dirA, false);
    useCommand(context, 'A');

    // Editor-style invocation: run `node <fakeClaude> chat`.
    const exit = await wrapperLaunch(context, [process.execPath, fakeClaude, 'chat']);
    expect(exit).toBe(0);
    const record = JSON.parse(readFileSync(path.join(dirA, 'fake-last-run.json'), 'utf8'));
    expect(record.configDir).toBe(dirA); // command ran on account A's config dir
    expect(getActive(context.ctx)).toBe('A'); // no cap, stays put
  });

  it('flips the active account to a healthy one when the command caps', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-wrap-'));
    const context = makeContext(home);
    const dirA = path.join(home, 'profiles', 'A');
    const dirB = path.join(home, 'profiles', 'B');
    await addCommand(context, 'A', { dir: dirA, login: false });
    await addCommand(context, 'B', { dir: dirB, login: false });
    seed(dirA, true); // active caps
    seed(dirB, false);
    useCommand(context, 'A');

    const exit = await wrapperLaunch(context, [process.execPath, fakeClaude, 'chat']);
    expect(exit).toBe(1);
    expect(loadLedger(context.ctx).caps.map((c) => c.account)).toContain('A');
    expect(getActive(context.ctx)).toBe('B'); // next editor chat uses B
  });
});
