import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboardCommand } from './dashboard.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';
import type { StatePayload } from '../dashboard/state-payload.js';

const fakeClaude = fileURLToPath(new URL('../../test/fake-claude/fake-claude.mjs', import.meta.url));

/**
 * The whole way from the account record to what `ccx state` and the dashboard
 * say about its tags: the command copies each account's fields by hand into
 * what it draws, which is where a new field is easiest to drop.
 */
function setup(): { context: CliContext; lines: string[] } {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-dash-tags-'));
  const dirs = ['work', 'ultra'].map((name) => {
    const dir = path.join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: name, refreshToken: 'r', expiresAt: Date.now() + 3_600_000 } }),
      'utf8',
    );
    writeFileSync(
      path.join(dir, 'fake-scenario.json'),
      JSON.stringify({ authStatus: { loggedIn: true, email: `${name}@example.com`, subscriptionType: 'max' } }),
      'utf8',
    );
    return { name, dir, ...(name === 'ultra' ? { tags: ['bot', 'pat'] } : {}) };
  });
  writeFileSync(
    path.join(home, 'accounts.json'),
    JSON.stringify({ accounts: dirs.map((a, priority) => ({ ...a, priority, enabled: true })) }),
    'utf8',
  );
  // The session is on `work`, so the line under the table says where it goes next.
  writeFileSync(path.join(home, 'active.json'), JSON.stringify({ active: 'work' }), 'utf8');
  writeFileSync(
    path.join(home, 'usage-snapshot.json'),
    JSON.stringify({
      accounts: {
        work: {
          fiveHour: 0.5,
          sevenDay: 0.4,
          fiveHourReset: Date.now() + 2 * 3_600_000,
          sevenDayReset: Date.now() + 90 * 3_600_000,
          at: Date.now(),
        },
        ultra: {
          fiveHour: null,
          noFiveHourLimit: true,
          sevenDay: 0.28,
          fiveHourReset: null,
          sevenDayReset: Date.now() + 30 * 3_600_000,
          at: Date.now(),
        },
      },
    }),
    'utf8',
  );
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  const lines: string[] = [];
  return {
    lines,
    context: {
      ctx,
      config: loadConfig(ctx),
      out: (m: string) => lines.push(m),
      err: () => {},
      json: false,
      quiet: false,
      claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    } as CliContext,
  };
}

describe('tags, from the account record to the screen', () => {
  it('reach `ccx state`, an empty list for an account without', async () => {
    const { context, lines } = setup();
    expect(await dashboardCommand(context, { json: true })).toBe(0);
    const state = JSON.parse(lines.join('\n')) as StatePayload;
    expect(state.accounts.map((a) => [a.name, a.tags])).toEqual([
      ['work', []],
      ['ultra', ['bot', 'pat']],
    ]);
  });

  it('reach the end of the dashboard row', async () => {
    const { context, lines } = setup();
    expect(await dashboardCommand(context, { once: true })).toBe(0);
    const row = lines.join('\n').split('\n').find((l) => /^ +\d* +\*? *ultra /.test(l));
    expect(row).toMatch(/#bot #pat/);
  });
});
