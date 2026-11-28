import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { statusCommand } from './status.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';

const fakeClaude = fileURLToPath(
  new URL('../../test/fake-claude/fake-claude.mjs', import.meta.url),
);

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** Accounts behind the fake `claude`: signed in as `live`, or signed out. */
function setup(
  fixtures: Array<{ name: string; live?: string; recorded?: string; claims?: string }>,
): { context: CliContext; lines: string[] } {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-status-'));
  made.push(home);
  const accounts = fixtures.map((f, priority) => {
    const dir = path.join(home, 'profiles', f.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'fake-scenario.json'),
      JSON.stringify({
        authStatus:
          f.live === undefined
            ? { loggedIn: false, authMethod: 'none' }
            : { loggedIn: true, authMethod: 'claude.ai', email: f.live },
      }),
      'utf8',
    );
    if (f.claims !== undefined) {
      writeFileSync(
        path.join(dir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: f.claims } }),
        'utf8',
      );
    }
    return {
      name: f.name,
      dir,
      priority,
      enabled: true,
      ...(f.recorded !== undefined ? { email: f.recorded } : {}),
    };
  });
  writeFileSync(path.join(home, 'accounts.json'), JSON.stringify({ accounts }), 'utf8');
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  const lines: string[] = [];
  return {
    lines,
    context: {
      ctx,
      config: loadConfig(ctx),
      out: (m: string) => lines.push(m),
      err: () => {},
      json: true,
      quiet: false,
      claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    } as CliContext,
  };
}

describe('ccx status and the address of each account', () => {
  it('names each account the way `ccx state` does: what its check reports, else its record', async () => {
    const { context, lines } = setup([
      { name: 'kept', recorded: 'kept@example.com' },
      { name: 'moved', live: 'now@example.com', recorded: 'was@example.com' },
      { name: 'claimed', claims: 'claimed@example.com' },
    ]);
    expect(await statusCommand(context)).toBe(0);
    const payload = JSON.parse(lines.join('\n')) as {
      schemaVersion: number;
      accounts: Array<{ name: string; loggedIn: boolean; email?: string }>;
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.accounts.map((a) => [a.name, a.loggedIn, a.email])).toEqual([
      ['kept', false, 'kept@example.com'],
      ['moved', true, 'now@example.com'],
      ['claimed', false, undefined],
    ]);
  });

  it('leaves out a blank address the check reports for an account with nothing recorded, as `ccx state` does', async () => {
    const { context, lines } = setup([
      { name: 'blank', live: '   ' },
      { name: 'kept', live: ' ', recorded: 'kept@example.com' },
    ]);
    expect(await statusCommand(context)).toBe(0);
    const payload = JSON.parse(lines.join('\n')) as {
      accounts: Array<{ name: string; loggedIn: boolean; email?: string; checkedAt: number }>;
    };
    const [blank, kept] = payload.accounts;
    expect(blank?.name).toBe('blank');
    expect(blank?.loggedIn).toBe(true);
    expect(typeof blank?.checkedAt).toBe('number');
    expect(Object.keys(blank ?? {})).not.toContain('email');
    expect(kept?.email).toBe('kept@example.com');
  });
});
