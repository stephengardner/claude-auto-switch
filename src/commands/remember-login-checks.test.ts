import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { statusCommand } from './status.js';
import { listCommand } from './list.js';
import { dashboardCommand } from './dashboard.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';
import type { StatePayload } from '../dashboard/state-payload.js';

const fakeClaude = fileURLToPath(
  new URL('../../test/fake-claude/fake-claude.mjs', import.meta.url),
);

/**
 * The checks `ccx status` and `ccx list` make are the ones a cheap `ccx state`
 * then uses, so a program that reads the state between them asks Claude about
 * no account at all. Without login files, so no usage is read over the network.
 */
function setup() {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-remember-checks-'));
  const accounts = ['a', 'b'].map((name, priority) => {
    const dir = path.join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'fake-scenario.json'),
      JSON.stringify({ authStatus: { loggedIn: true } }),
      'utf8',
    );
    return { name, dir, priority, enabled: true };
  });
  writeFileSync(path.join(home, 'accounts.json'), JSON.stringify({ accounts }), 'utf8');
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  const lines: string[] = [];
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    out: (m: string) => lines.push(m),
    json: true,
    quiet: false,
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
  };
  const said = (): unknown => {
    const text = lines.join('\n');
    lines.length = 0;
    return JSON.parse(text);
  };
  const remembered = (): Record<string, { checkedAt: number }> =>
    (
      JSON.parse(readFileSync(path.join(home, 'login-checks.json'), 'utf8')) as {
        checks: Record<string, { checkedAt: number }>;
      }
    ).checks;
  return { context, said, remembered };
}

describe('the login checks other commands make', () => {
  it('from `ccx status` are the ones a cheap `ccx state` uses', async () => {
    const { context, said } = setup();
    expect(await statusCommand(context)).toBe(0);
    const status = said() as { accounts: Array<{ name: string; checkedAt: number }> };
    expect(await dashboardCommand(context, { json: true, cachedLogins: '600' })).toBe(0);
    const state = said() as StatePayload;
    expect(state.accounts.map((a) => [a.name, a.loginCheckedAt])).toEqual(
      status.accounts.map((a) => [a.name, a.checkedAt]),
    );
  });

  it('from `ccx list` are remembered too', async () => {
    const { context, said, remembered } = setup();
    expect(await listCommand(context, {}, { tagged: [] })).toBe(0);
    said();
    expect(Object.keys(remembered()).sort()).toEqual(['a', 'b']);
  });
});
