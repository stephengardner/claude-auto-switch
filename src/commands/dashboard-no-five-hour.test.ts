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
 * The whole way from the stored usage to what `ccx state` and the dashboard
 * say, for an account with no 5-hour limit. The renderers are tested on their
 * own with the flag handed in; this pins that the command hands it over,
 * which a field copied by hand in between can quietly stop doing.
 *
 * The usage is written fresh, so the command reads it and asks no one.
 */
function setup(): { context: CliContext; lines: string[] } {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-dash-5h-'));
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
    return { name, dir };
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

describe('an account with no 5-hour limit, from the store to the screen', () => {
  it('reaches `ccx state` as a fact, with the pick reason told by its week', async () => {
    const { context, lines } = setup();
    expect(await dashboardCommand(context, { json: true })).toBe(0);
    const state = JSON.parse(lines.join('\n')) as StatePayload;
    const ultra = state.accounts.find((a) => a.name === 'ultra');
    expect(ultra?.usage).toMatchObject({ fiveHour: null, noFiveHourLimit: true, sevenDay: 0.28 });
    expect(ultra?.status.state).toBe('ready');
    expect(state.nextUp).toContain('no 5-hour limit, 72% of its week left');
  });

  it('reaches the dashboard as "no limit", never as an unread ?', async () => {
    const { context, lines } = setup();
    expect(await dashboardCommand(context, { once: true })).toBe(0);
    const row = lines.join('\n').split('\n').find((l) => /^ +\d* +\*? *ultra /.test(l));
    expect(row).toMatch(/ultra +no limit +███████░░░  72%/);
    expect(row).not.toContain('?');
  });
});
