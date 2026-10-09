import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loginCommand } from './login.js';
import { rememberDeadLogin } from '../usage/dead-login-store.js';
import { credentialFileFingerprint, previousCredentialPath } from '../accounts/credential-vault.js';
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
  // A display, so these tests drive the browser path on every platform; a Linux
  // runner with none would otherwise count as a machine nobody is at.
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, DISPLAY: ':0' } as NodeJS.ProcessEnv };
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

describe('ccx login on a machine nobody is at', () => {
  const signedOut = (accts: Array<{ name: string }>) =>
    Promise.resolve(accts.map((a) => ({ name: a.name, loggedIn: false }))) as never;

  function quietSetup(names: string[]) {
    const s = setup(names);
    (s.context as { lookupOwner?: unknown }).lookupOwner = () => Promise.resolve(null);
    return s;
  }

  it('hands the sign-in to the terminal when there is no browser to drive', async () => {
    const { context, lines } = quietSetup(['a']);
    const viaTerminal: string[] = [];
    const viaBrowser: string[] = [];
    const code = await loginCommand(context, 'a', {}, {
      headless: true,
      browserReachable: () => Promise.resolve(false),
      terminalLogin: (account) => {
        viaTerminal.push(account.name);
        return Promise.resolve({ account: account.name, ok: true, detail: 'logged in (in the terminal)' });
      },
      login: (account) => {
        viaBrowser.push(account.name);
        return Promise.resolve({ ok: true }) as never;
      },
    });
    expect(code).toBe(0);
    expect(viaTerminal).toEqual(['a']);
    expect(viaBrowser).toEqual([]);
    expect(lines.join('\n')).toContain('no browser on this machine');
  });

  it('still drives the browser when one is reachable, even over SSH', async () => {
    const { context } = quietSetup(['a']);
    const viaBrowser: string[] = [];
    await loginCommand(context, undefined, { all: true }, {
      probe: signedOut,
      headless: true,
      browserReachable: () => Promise.resolve(true),
      terminalLogin: () => Promise.reject(new Error('should not be used')),
      login: (account) => {
        viaBrowser.push(account.name);
        return Promise.resolve({ ok: true }) as never;
      },
    });
    expect(viaBrowser).toEqual(['a']);
  });

  it('leaves a desktop with no debug port on the browser path, as before', async () => {
    const { context } = quietSetup(['a']);
    const viaBrowser: string[] = [];
    await loginCommand(context, 'a', {}, {
      headless: false,
      browserReachable: () => Promise.resolve(false),
      terminalLogin: () => Promise.reject(new Error('should not be used')),
      login: (account) => {
        viaBrowser.push(account.name);
        return Promise.resolve({ ok: true }) as never;
      },
    });
    expect(viaBrowser).toEqual(['a']);
  });
});

describe('ccx login --relay', () => {
  it('relays the named account and then checks who signed in', async () => {
    const { context } = setup(['a']);
    const owners: string[] = [];
    (context as { lookupOwner?: unknown }).lookupOwner = (dir: string) => {
      owners.push(dir);
      return Promise.resolve(null);
    };
    const relayed: string[] = [];
    const code = await loginCommand(context, 'a', { relay: true }, {
      relay: (account) => {
        relayed.push(account.name);
        return Promise.resolve({ account: account.name, ok: true, detail: 'logged in (relayed)' });
      },
    });
    expect(code).toBe(0);
    expect(relayed).toEqual(['a']);
    expect(owners).toHaveLength(1);
  });

  it('signs in exactly one named account', async () => {
    const { context, lines } = setup(['a', 'b']);
    expect(await loginCommand(context, undefined, { relay: true, all: true })).toBe(1);
    expect(lines.join('\n')).toContain('one named account');
  });

  it('fails without checking anything when the relay did not produce a login', async () => {
    const { context } = setup(['a']);
    let looked = false;
    (context as { lookupOwner?: unknown }).lookupOwner = () => {
      looked = true;
      return Promise.resolve(null);
    };
    const code = await loginCommand(context, 'a', { relay: true }, {
      relay: (account) => Promise.resolve({ account: account.name, ok: false, detail: 'no code arrived' }),
    });
    expect(code).toBe(1);
    expect(looked).toBe(false);
  });
});

describe('ccx login --host', () => {
  it('hands the whole job to the remote sign-in, with its options', async () => {
    const { context } = setup(['a']);
    const calls: unknown[] = [];
    const code = await loginCommand(context, undefined, { host: 'beast', all: true, remoteCcx: '/opt/ccx' }, {
      remote: (_c, host, name, options) => {
        calls.push({ host, name, options });
        return Promise.resolve(0);
      },
    });
    expect(code).toBe(0);
    expect(calls).toEqual([{ host: 'beast', name: undefined, options: { all: true, remoteCcx: '/opt/ccx' } }]);
  });
});

describe('a refused sign-in puts back the login it replaced', () => {
  it('restores the working login, not an older one a renewal already spent', async () => {
    const { context, accounts } = setup(['work']);
    const dir = accounts[0]!.dir;
    const write = (file: string, refresh: string) =>
      writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: `at-${refresh}`, refreshToken: refresh } }));
    write(path.join(dir, '.credentials.json'), 'rt-working');
    write(previousCredentialPath(dir), 'rt-spent-by-last-renewal');
    writeFileSync(
      path.join(path.dirname(dir), '..', 'accounts.json'),
      JSON.stringify({ accounts: [{ ...accounts[0], email: 'work@example.com' }] }),
    );
    (context as { lookupOwner?: unknown }).lookupOwner = () => Promise.resolve('personal@example.com');

    const code = await loginCommand(context, 'work', {}, {
      headless: false,
      login: (account) => {
        // What claude auth login does when the browser is signed in to another account.
        write(path.join(account.dir, '.credentials.json'), 'rt-wrong-account');
        return Promise.resolve({ account: account.name, ok: true, detail: 'logged in (authorized)' });
      },
    });

    expect(code).toBe(1);
    const live = JSON.parse(readFileSync(path.join(dir, '.credentials.json'), 'utf8')) as {
      claudeAiOauth: { refreshToken: string };
    };
    expect(live.claudeAiOauth.refreshToken).toBe('rt-working');
  });
});
