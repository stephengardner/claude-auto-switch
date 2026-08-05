import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { usageCommand } from './usage.js';
import { rememberDeadLogin } from '../usage/dead-login-store.js';
import { credentialFileFingerprint } from '../accounts/credential-vault.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';

/**
 * The snapshot is written FRESH on purpose: `refreshUsage` only touches accounts
 * whose entry is older than the TTL, so a current one makes this command a pure
 * read and the test needs no network.
 */
function setup(): { context: CliContext; lines: string[]; dir: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-usage-'));
  const dir = path.join(home, 'profiles', 'work');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } }),
    'utf8',
  );
  writeFileSync(
    path.join(home, 'accounts.json'),
    JSON.stringify({ accounts: [{ name: 'work', dir, priority: 0, enabled: true }] }),
    'utf8',
  );
  writeFileSync(path.join(home, 'active.json'), JSON.stringify({ active: 'work' }), 'utf8');
  writeFileSync(
    path.join(home, 'usage-snapshot.json'),
    JSON.stringify({
      accounts: {
        work: {
          fiveHour: 0.1,
          sevenDay: 0.2,
          fiveHourReset: null,
          sevenDayReset: null,
          at: Date.now(),
        },
      },
    }),
    'utf8',
  );

  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  const lines: string[] = [];
  return {
    dir,
    lines,
    context: {
      ctx,
      config: loadConfig(ctx),
      out: (m: string) => lines.push(m),
      err: () => {},
      json: false,
      quiet: false,
    } as CliContext,
  };
}

describe('ccx usage and a login that has been rejected', () => {
  it('does not recommend an account that cannot sign in, and says what to do', async () => {
    // The wiring this pins: the command has to ASK the store. Everything below
    // it was already tested with the flag passed in by hand, which proves the
    // renderer and not the command.
    const { context, lines, dir } = setup();
    rememberDeadLogin(credentialFileFingerprint(dir), 'invalid_grant', context.ctx);

    expect(await usageCommand(context)).toBe(0);
    const out = lines.join('\n');

    expect(out).toContain('NEEDS SIGN-IN');
    expect(out).toContain('These accounts need signing in again: work');
    expect(out).toContain('ccx login work');
    expect(out).not.toContain('Most room right now');
  });

  it('recommends it normally when the login has NOT been rejected', async () => {
    const { context, lines } = setup();
    expect(await usageCommand(context)).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('Most room right now');
    expect(out).not.toContain('NEEDS SIGN-IN');
  });
});
