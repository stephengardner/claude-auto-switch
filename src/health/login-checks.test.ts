import { describe, it, expect } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCachedLogins, probeAllRemembered, rememberChecks } from './login-checks.js';
import { probe } from './prober.js';

const fakeClaude = fileURLToPath(
  new URL('../../test/fake-claude/fake-claude.mjs', import.meta.url),
);
const claude = { bin: process.execPath, prefixArgs: [fakeClaude] };
const NOW = 1_800_000_000_000;

function setup(names: string[]) {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-login-checks-'));
  const c = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  const accounts = names.map((name) => {
    const dir = path.join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'fake-scenario.json'),
      JSON.stringify({
        authStatus: { loggedIn: true, email: `${name}@example.com`, subscriptionType: 'max' },
      }),
      'utf8',
    );
    return { name, dir };
  });
  const remembered = (dir: string, checkedAt: number, loggedIn = true) => ({
    dir,
    checkedAt,
    loggedIn,
  });
  const writeChecks = (checks: Record<string, object>) =>
    writeFileSync(path.join(home, 'login-checks.json'), JSON.stringify({ checks }), 'utf8');
  return { home, c, accounts, remembered, writeChecks };
}

describe('remembered login checks', () => {
  it('checks every account and remembers what it found', async () => {
    const { home, c, accounts } = setup(['a', 'b']);
    const results = await probeAllRemembered(accounts, { claude, now: () => NOW }, c);
    expect(results.map((r) => [r.name, r.loggedIn, r.checkedAt])).toEqual([
      ['a', true, NOW],
      ['b', true, NOW],
    ]);
    const file = JSON.parse(readFileSync(path.join(home, 'login-checks.json'), 'utf8')) as {
      checks: Record<string, { dir: string; checkedAt: number; loggedIn: boolean; email?: string }>;
    };
    expect(file.checks['a']).toMatchObject({
      dir: accounts[0]?.dir,
      checkedAt: NOW,
      loggedIn: true,
      email: 'a@example.com',
    });
  });

  it('uses a check younger than the bound instead of asking, and asks about the rest', async () => {
    const { c, accounts, remembered, writeChecks } = setup(['young', 'old']);
    writeChecks({
      young: remembered(accounts[0]?.dir ?? '', NOW - 10_000, false),
      old: remembered(accounts[1]?.dir ?? '', NOW - 120_000, false),
    });
    const results = await probeAllRemembered(accounts, { claude, now: () => NOW }, c, 60_000);
    // The young one is the remembered answer, with its own time; the old one was asked again.
    expect(results.map((r) => [r.name, r.loggedIn, r.checkedAt])).toEqual([
      ['young', false, NOW - 10_000],
      ['old', true, NOW],
    ]);
  });

  it('never uses a check made for another folder, or one older than its login', async () => {
    const { c, accounts, remembered, writeChecks } = setup(['moved', 'signed-in']);
    const [moved, signedIn] = accounts;
    // Signed in after the check: the login file changed since.
    const login = path.join(signedIn?.dir ?? '', '.credentials.json');
    writeFileSync(login, '{}', 'utf8');
    utimesSync(login, new Date(NOW - 1_000), new Date(NOW - 1_000));
    writeChecks({
      moved: remembered('/somewhere/else', NOW - 1_000, false),
      'signed-in': remembered(signedIn?.dir ?? '', NOW - 5_000, false),
    });
    const results = await probeAllRemembered(accounts, { claude, now: () => NOW }, c, 60_000);
    expect(results.map((r) => [r.name, r.loggedIn, r.checkedAt])).toEqual([
      [moved?.name, true, NOW],
      [signedIn?.name, true, NOW],
    ]);
  });

  it('never uses a check from the future, as a clock set back would leave', async () => {
    const { c, accounts, remembered, writeChecks } = setup(['a']);
    writeChecks({ a: remembered(accounts[0]?.dir ?? '', NOW + 60_000, false) });
    const [result] = await probeAllRemembered(accounts, { claude, now: () => NOW }, c, 600_000);
    expect(result?.checkedAt).toBe(NOW);
  });

  it('does not remember a check that could not be read, and keeps the one before it', () => {
    const { home, c, accounts, remembered, writeChecks } = setup(['a']);
    writeChecks({ a: remembered(accounts[0]?.dir ?? '', NOW - 1_000, true) });
    rememberChecks([{ name: 'a', checkedAt: NOW, loggedIn: false, error: 'no JSON' }], accounts, c);
    const file = JSON.parse(readFileSync(path.join(home, 'login-checks.json'), 'utf8')) as {
      checks: Record<string, { checkedAt: number }>;
    };
    expect(file.checks['a']?.checkedAt).toBe(NOW - 1_000);
  });

  it('keeps every other registered account when it checked only some', () => {
    const { home, c, accounts, remembered, writeChecks } = setup(['a', 'b', 'c']);
    writeFileSync(
      path.join(home, 'accounts.json'),
      JSON.stringify({
        accounts: accounts.map((a, priority) => ({ ...a, priority, enabled: true })),
      }),
      'utf8',
    );
    writeChecks({
      a: remembered(accounts[0]?.dir ?? '', NOW - 9_000),
      b: remembered(accounts[1]?.dir ?? '', NOW - 8_000),
      c: remembered(accounts[2]?.dir ?? '', NOW - 7_000),
    });
    // `ccx status a`: one account checked.
    rememberChecks([{ name: 'a', checkedAt: NOW, loggedIn: true }], [accounts[0]!], c);
    const file = JSON.parse(readFileSync(path.join(home, 'login-checks.json'), 'utf8')) as {
      checks: Record<string, { checkedAt: number }>;
    };
    expect(
      Object.fromEntries(Object.entries(file.checks).map(([n, k]) => [n, k.checkedAt])),
    ).toEqual({
      a: NOW,
      b: NOW - 8_000,
      c: NOW - 7_000,
    });
  });

  it('asks again about a login that was written while its check was running', async () => {
    const { home, c, accounts } = setup(['a']);
    // A stand-in for `claude auth status`: it reads the folder as it starts (signed out),
    // a sign-in then writes the login, and only then does it answer.
    const stub = path.join(home, 'slow-auth.mjs');
    writeFileSync(
      stub,
      [
        "import { writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        'const dir = process.env.CLAUDE_CONFIG_DIR;',
        "writeFileSync(path.join(dir, '.credentials.json'), '{}');",
        'setTimeout(() => console.log(JSON.stringify({ loggedIn: false })), 400);',
      ].join('\n'),
      'utf8',
    );
    const slow = { bin: process.execPath, prefixArgs: [stub] };
    const [first] = await probeAllRemembered(accounts, { claude: slow }, c);
    expect(first?.loggedIn).toBe(false);
    // The check answered about a folder whose login changed during it: not reused.
    const [second] = await probeAllRemembered(accounts, { claude }, c, 600_000);
    expect(second?.loggedIn).toBe(true);
    expect(second?.checkedAt).toBeGreaterThan(first?.checkedAt ?? Infinity);
  });

  it('stamps a check with when it began, so a login written while it ran is newer', async () => {
    const { accounts } = setup(['a']);
    const times = [NOW, NOW + 5_000];
    const result = await probe(accounts[0]!, { claude, now: () => times.shift() ?? NOW + 9_000 });
    expect(result.checkedAt).toBe(NOW);
  });

  it('forgets an account that is no longer registered', () => {
    const { home, c, accounts, remembered, writeChecks } = setup(['a']);
    writeChecks({ gone: remembered('/p/gone', NOW, true) });
    rememberChecks([{ name: 'a', checkedAt: NOW, loggedIn: true }], accounts, c);
    const file = JSON.parse(readFileSync(path.join(home, 'login-checks.json'), 'utf8')) as {
      checks: Record<string, unknown>;
    };
    expect(Object.keys(file.checks)).toEqual(['a']);
  });

  it('reads an unreadable file as nothing remembered', async () => {
    const { home, c, accounts } = setup(['a']);
    writeFileSync(path.join(home, 'login-checks.json'), 'not json', 'utf8');
    const [result] = await probeAllRemembered(accounts, { claude, now: () => NOW }, c, 60_000);
    expect(result?.checkedAt).toBe(NOW);
    expect(existsSync(path.join(home, 'login-checks.json'))).toBe(true);
  });
});

describe('--cached-logins', () => {
  it('takes seconds, zero included', () => {
    expect(parseCachedLogins('60')).toEqual({ ms: 60_000 });
    expect(parseCachedLogins('0')).toEqual({ ms: 0 });
    expect(parseCachedLogins('1.5')).toEqual({ ms: 1_500 });
  });

  it('refuses anything that is not a number of seconds, naming what it got', () => {
    for (const raw of ['', 'soon', '-1', 'Infinity', '0x10', '1e3', '1e400', '1,5']) {
      expect(parseCachedLogins(raw)).toEqual({ error: expect.stringContaining(`"${raw}"`) });
    }
  });
});
