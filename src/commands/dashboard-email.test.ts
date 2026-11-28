import { afterEach, describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboardCommand } from './dashboard.js';
import { loginCommand, type LoginCommandDeps } from './login.js';
import { loadConfig } from '../config/config.js';
import { verifyAccountIdentities } from '../accounts/identity-check.js';
import type { CliContext } from '../context.js';
import type { StatePayload } from '../dashboard/state-payload.js';

const fakeClaude = fileURLToPath(
  new URL('../../test/fake-claude/fake-claude.mjs', import.meta.url),
);

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

interface Fixture {
  name: string;
  /** What `claude auth status` reports in its folder; signed out when absent. */
  live?: string;
  /** What the account record holds. */
  recorded?: string;
  /** What the profile's own `.claude.json` says it is signed in as. */
  claims?: string;
  /** A stored login, named so it is told apart from another. */
  token?: string;
}

/** What the fake `claude` reports in `dir`: signed in as `email`, or signed out. */
function signIn(dir: string, email: string | undefined): void {
  writeFileSync(
    path.join(dir, 'fake-scenario.json'),
    JSON.stringify({
      authStatus:
        email === undefined
          ? { loggedIn: false, authMethod: 'none' }
          : { loggedIn: true, authMethod: 'claude.ai', email, subscriptionType: 'max' },
    }),
    'utf8',
  );
}

function claim(dir: string, email: string): void {
  writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email } }),
    'utf8',
  );
}

function storeLogin(dir: string, token: string): void {
  writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: `acc-${token}`, refreshToken: `ref-${token}` },
    }),
    'utf8',
  );
}

/**
 * Accounts in every state an address can come from, behind the fake `claude`,
 * in a ccx home of their own. Usage is written fresh, so nothing here touches
 * the network, and no newer ccx is ever followed.
 */
function setup(fixtures: Fixture[]): {
  context: CliContext;
  home: string;
  dirs: Map<string, string>;
} {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-dash-email-'));
  made.push(home);
  const dirs = new Map<string, string>();
  for (const f of fixtures) {
    const dir = path.join(home, 'profiles', f.name);
    mkdirSync(dir, { recursive: true });
    dirs.set(f.name, dir);
    signIn(dir, f.live);
    if (f.claims !== undefined) claim(dir, f.claims);
    if (f.token !== undefined) storeLogin(dir, f.token);
  }
  writeFileSync(
    path.join(home, 'accounts.json'),
    JSON.stringify({
      accounts: fixtures.map((f, priority) => ({
        name: f.name,
        dir: dirs.get(f.name),
        priority,
        enabled: true,
        ...(f.recorded !== undefined ? { email: f.recorded } : {}),
      })),
    }),
    'utf8',
  );
  writeFileSync(
    path.join(home, 'usage-snapshot.json'),
    JSON.stringify({
      accounts: Object.fromEntries(
        fixtures.map((f) => [
          f.name,
          {
            fiveHour: 0.1,
            sevenDay: 0.1,
            fiveHourReset: null,
            sevenDayReset: null,
            at: Date.now(),
          },
        ]),
      ),
    }),
    'utf8',
  );
  const ctx = {
    env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home, DISPLAY: ':0' },
  };
  return {
    home,
    dirs,
    context: {
      ctx,
      config: loadConfig(ctx),
      out: () => {},
      err: () => {},
      json: false,
      quiet: false,
      claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
      newerInstall: () => null,
    } as CliContext,
  };
}

type StateAccount = StatePayload['accounts'][number];

async function state(context: CliContext): Promise<Map<string, StateAccount>> {
  const lines: string[] = [];
  expect(
    await dashboardCommand({ ...context, out: (m: string) => lines.push(m) }, { json: true }),
  ).toBe(0);
  const payload = JSON.parse(lines.join('\n')) as StatePayload;
  return new Map(payload.accounts.map((a) => [a.name, a]));
}

/** The two address fields only, as a reader sees them. */
const addressOf = (a: StateAccount | undefined) => ({
  email: a?.email,
  claimedEmail: a?.claimedEmail,
});

function recorded(home: string, name: string): string | undefined {
  const file = JSON.parse(readFileSync(path.join(home, 'accounts.json'), 'utf8')) as {
    accounts: Array<{ name: string; email?: string }>;
  };
  return file.accounts.find((a) => a.name === name)?.email;
}

/** The account file's bytes, with its time set an hour back so a rewrite would show. */
function untouched(home: string): () => void {
  const file = path.join(home, 'accounts.json');
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(file, past, past);
  const before = readFileSync(file, 'utf8');
  return () => {
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(statSync(file).mtimeMs).toBeLessThan(Date.now() - 1_800_000);
  };
}

describe('the address `ccx state` gives each account', () => {
  it('is no `email` but a `claimedEmail`, for a signed-out account with nothing recorded', async () => {
    const { context } = setup([{ name: 'out', claims: 'owner@example.com' }]);
    const out = (await state(context)).get('out');
    expect(out?.loggedIn).toBe(false);
    expect(addressOf(out)).toEqual({ email: undefined, claimedEmail: 'owner@example.com' });
  });

  it('is the recorded one once signed out, with no claim beside it', async () => {
    const { context } = setup([
      { name: 'kept', recorded: 'kept@example.com', claims: 'claimed@example.com' },
    ]);
    expect(addressOf((await state(context)).get('kept'))).toEqual({
      email: 'kept@example.com',
      claimedEmail: undefined,
    });
  });

  it('is the live one for an account signed in as another than its record', async () => {
    const { context, home } = setup([
      { name: 'moved', live: 'now@example.com', recorded: 'was@example.com' },
    ]);
    expect((await state(context)).get('moved')?.email).toBe('now@example.com');
    expect(recorded(home, 'moved')).toBe('was@example.com');
  });

  it('is neither for a profile left claiming a twin after its sign-in was refused', async () => {
    // A refused sign-in puts the credential back, not the profile's claim, so
    // b keeps claiming the address a is signed in and recorded as.
    const { context } = setup([
      {
        name: 'a',
        live: 'twin@example.com',
        recorded: 'twin@example.com',
        claims: 'twin@example.com',
        token: 'a',
      },
      { name: 'b', claims: 'twin@example.com' },
    ]);
    const published = await state(context);
    expect(addressOf(published.get('a'))).toEqual({
      email: 'twin@example.com',
      claimedEmail: undefined,
    });
    expect(addressOf(published.get('b'))).toEqual({ email: undefined, claimedEmail: undefined });
  });

  it('is neither for two signed-out profiles left claiming one address after a shared-login refusal', async () => {
    const { context } = setup([
      { name: 'a', claims: 'dup@example.com', token: 'shared' },
      { name: 'b', claims: 'dup@example.com' },
    ]);
    const published = await state(context);
    expect(addressOf(published.get('a'))).toEqual({ email: undefined, claimedEmail: undefined });
    expect(addressOf(published.get('b'))).toEqual({ email: undefined, claimedEmail: undefined });
  });

  it('is the live one for a signed-in profile whose own claim is that address, and nothing is written', async () => {
    const { context, home } = setup([
      { name: 'work', live: 'work@example.com', claims: 'work@example.com', token: 'w' },
    ]);
    const check = untouched(home);
    expect(addressOf((await state(context)).get('work'))).toEqual({
      email: 'work@example.com',
      claimedEmail: undefined,
    });
    check();
  });

  it('is what the identity check expects, in one field or the other, for a signed-out account no one else holds', async () => {
    const fixtures: Fixture[] = [
      { name: 'out', claims: 'out@example.com' },
      { name: 'kept', recorded: 'kept@example.com', claims: 'claimed@example.com' },
      { name: 'none' },
    ];
    const { context, dirs } = setup(fixtures);
    const published = await state(context);
    // No profile here holds a login, so the check never asks the API.
    const unanswered: typeof fetch = async () => new Response('{}', { status: 401 });
    const findings = await verifyAccountIdentities(
      fixtures.map((f) => ({
        name: f.name,
        dir: dirs.get(f.name)!,
        ...(f.recorded !== undefined ? { email: f.recorded } : {}),
      })),
      unanswered,
    );
    expect(findings.map((f) => [f.account, f.kind, f.expected])).toEqual(
      fixtures.map((f) => {
        const a = published.get(f.name);
        return [f.name, 'logged-out', a?.email ?? a?.claimedEmail];
      }),
    );
  });
});

describe('reading `ccx state` writes nothing', () => {
  it('leaves an account signed in outside ccx unrecorded, so its real owner can still sign in', async () => {
    const { context, home } = setup([
      { name: 'work', live: 'stranger@example.com', claims: 'stranger@example.com', token: 's' },
    ]);
    const check = untouched(home);
    expect((await state(context)).get('work')?.email).toBe('stranger@example.com');
    check();

    // The owner's own sign-in through ccx, confirmed by the API, is accepted.
    const lines: string[] = [];
    const signingIn = {
      ...context,
      out: (m: string) => lines.push(m),
      lookupOwner: () => Promise.resolve('owner@example.com'),
    } as CliContext;
    const browser: LoginCommandDeps = {
      headless: false,
      browserReachable: () => Promise.resolve(true),
      login: (account) => {
        storeLogin(account.dir, 'owner');
        claim(account.dir, 'owner@example.com');
        signIn(account.dir, 'owner@example.com');
        return Promise.resolve({ account: account.name, ok: true, detail: 'signed in (test)' });
      },
    };
    expect(await loginCommand(signingIn, 'work', {}, browser)).toBe(0);
    expect(recorded(home, 'work')).toBe('owner@example.com');
    expect(lines.join('\n')).not.toContain('REFUSED');
  });
});
