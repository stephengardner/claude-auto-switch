import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loginCommand } from './login.js';
import { rememberDeadLogin } from '../usage/dead-login-store.js';
import { credentialFileFingerprint } from '../accounts/credential-vault.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';

/**
 * The probe is injected rather than spawned. `ccx login --all` decides from the
 * probe's answer, and driving the real prober would make these assertions
 * depend on a subprocess finishing, which is what made an earlier test pass on
 * Windows and fail on Linux for a reason unrelated to the rule.
 */
function setup(names: string[]) {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-login-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  const accounts = names.map((name, i) => {
    const dir = path.join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: `tok-${name}`, refreshToken: `refresh-${name}` } }),
      'utf8',
    );
    return { name, dir, priority: i, enabled: true };
  });
  writeFileSync(path.join(home, 'accounts.json'), JSON.stringify({ accounts }), 'utf8');

  const lines: string[] = [];
  const context = {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: 'never-run', prefixArgs: [] },
    out: (m: string) => lines.push(m),
    err: () => {},
    json: false,
    quiet: false,
  } as unknown as CliContext;
  return { home, ctx, accounts, context, lines };
}

/** Every account looks signed in, which is what the probe says about a refused one. */
const allSignedIn = (accounts: Array<{ name: string }>) =>
  Promise.resolve(accounts.map((a) => ({ name: a.name, loggedIn: true }))) as never;

describe('ccx login --all', () => {
  it('signs in an account whose login was REFUSED, even though the probe calls it signed in', async () => {
    // The bug: the probe reports a refused login as signed in, because the file
    // still looks like one. Going by the probe alone made the command whose
    // whole purpose is to fix that skip exactly those accounts.
    const { ctx, accounts, context } = setup(['dead', 'good']);
    rememberDeadLogin(
      credentialFileFingerprint(accounts[0]!.dir),
      'token endpoint 400: invalid_grant',
      ctx,
    );

    const attempted: string[] = [];
    await loginCommand(context, undefined, { all: true }, {
      probe: (accts) => allSignedIn(accts),
      login: (account) => {
        attempted.push(account.name);
        return Promise.resolve({ ok: true }) as never;
      },
    });

    expect(attempted).toEqual(['dead']);
  });

  it('says there is nothing to do when every login works', async () => {
    const { accounts, context, lines } = setup(['a', 'b']);
    const attempted: string[] = [];
    const code = await loginCommand(context, undefined, { all: true }, {
      probe: (accts) => allSignedIn(accts),
      login: (account) => {
        attempted.push(account.name);
        return Promise.resolve({ ok: true }) as never;
      },
    });

    expect(code).toBe(0);
    expect(attempted).toEqual([]);
    expect(lines.join('\n')).toContain('all accounts are already logged in');
    expect(accounts).toHaveLength(2);
  });

  it('still signs in an account the probe says is signed out', async () => {
    const { context } = setup(['out', 'fine']);
    const attempted: string[] = [];
    await loginCommand(context, undefined, { all: true }, {
      probe: (accts) =>
        Promise.resolve(
          accts.map((a) => ({ name: a.name, loggedIn: a.name !== 'out' })),
        ) as never,
      login: (account) => {
        attempted.push(account.name);
        return Promise.resolve({ ok: true }) as never;
      },
    });

    expect(attempted).toEqual(['out']);
  });
});
