import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCommand } from '../../src/commands/add.js';
import { listCommand } from '../../src/commands/list.js';
import { useCommand } from '../../src/commands/use.js';
import { runCommand } from '../../src/commands/run.js';
import { loadConfig } from '../../src/config/config.js';
import { getAccount } from '../../src/accounts/registry.js';
import type { CliContext } from '../../src/context.js';

const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));

function makeContext(home: string, lines: string[]): CliContext {
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  return {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    out: (message) => lines.push(message),
    json: false,
    quiet: false,
  };
}

function seedScenario(dir: string, loggedIn: boolean): void {
  mkdirSync(dir, { recursive: true });
  const authStatus = loggedIn
    ? { loggedIn: true, subscriptionType: 'max', email: 'in@example.com' }
    : { loggedIn: false, authMethod: 'none' };
  writeFileSync(path.join(dir, 'fake-scenario.json'), JSON.stringify({ authStatus }), 'utf8');
}

describe('switch integration (against fake-claude)', () => {
  it('registers accounts, lists them, and runs on the pinned account', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-e2e-'));
    const lines: string[] = [];
    const context = makeContext(home, lines);

    const dirA = path.join(home, 'profiles', 'A');
    const dirB = path.join(home, 'profiles', 'B');
    await addCommand(context, 'A', { dir: dirA, login: false });
    await addCommand(context, 'B', { dir: dirB, login: false });
    seedScenario(dirA, false); // A logged out
    seedScenario(dirB, true); // B logged in

    lines.length = 0;
    await listCommand(context);
    const listOut = lines.join('\n');
    expect(listOut).toContain('A');
    expect(listOut).toContain('B');
    expect(listOut).toContain('yes'); // B is logged in

    expect(useCommand(context, 'B')).toBe(0);
    const exit = await runCommand(context, ['-p', 'hi']);
    expect(exit).toBe(0);

    const dirOfB = getAccount('B', context.ctx)?.dir ?? '';
    const record = JSON.parse(readFileSync(path.join(dirOfB, 'fake-last-run.json'), 'utf8'));
    expect(record.configDir).toBe(dirOfB);
    expect(record.args).toEqual(['-p', 'hi']);
  });
});
