import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listCommand } from './list.js';
import { updateAccount } from '../accounts/registry.js';
import { refreshCredentialIfExpired } from '../usage/oauth-refresh.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';

/**
 * The probe is injected rather than spawned. `ccx list` shows what the probe
 * says, and driving the real one would make these assertions depend on a
 * subprocess finishing rather than on the rule under test.
 */
function setup(names: string[]) {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-list-'));
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
    json: true,
    quiet: false,
  } as unknown as CliContext;
  return { ctx, accounts, context, lines };
}

const allSignedIn = (accounts: Array<{ name: string }>) =>
  Promise.resolve(accounts.map((a) => ({ name: a.name, loggedIn: true }))) as never;

/** The rows out of the JSON envelope every machine-readable output now uses. */
const rows = (lines: string[]): Array<{ name: string; loggedIn: string }> => {
  const payload = JSON.parse(lines.join('\n')) as {
    schemaVersion: number;
    accounts: Array<{ name: string; loggedIn: string }>;
  };
  expect(payload.schemaVersion).toBe(1);
  return payload.accounts;
};

describe('ccx list', () => {
  it('shows a refused login as NOT logged in, whatever the probe says', async () => {
    // This table is where someone looks to find out which accounts they can
    // use. The probe reports a refused login as signed in, because the file
    // still looks like one, so this was the most misleading place to repeat it.
    const { accounts, context, lines } = setup(['dead', 'good']);
    // The refusal is recorded by the REAL renewal against a rejecting endpoint,
    // not seeded with the same helper this then reads with. Seeding both sides
    // agrees with itself even when the writer and the reader disagree, which is
    // a mismatch that has shipped once already.
    writeFileSync(
      path.join(accounts[0]!.dir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'old', refreshToken: 'finished', expiresAt: Date.now() - 60_000 },
      }),
      'utf8',
    );
    const outcome = await refreshCredentialIfExpired(accounts[0]!.dir, {
      ctx: context.ctx,
      fetchImpl: () =>
        Promise.resolve(
          new Response('{"error":"invalid_grant"}', {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });
    expect(outcome.status).toBe('needs-login');

    await listCommand(context, { probe: (accts) => allSignedIn(accts) });

    const byName = new Map(rows(lines).map((r) => [r.name, r.loggedIn]));
    expect(byName.get('dead')).toBe('no');
    expect(byName.get('good')).toBe('yes');
  });

  it('still shows a working login as logged in', async () => {
    const { context, lines } = setup(['a', 'b']);
    await listCommand(context, { probe: (accts) => allSignedIn(accts) });
    expect(rows(lines).map((r) => r.loggedIn)).toEqual(['yes', 'yes']);
  });

  it('reports an account the probe says is signed out as not logged in', async () => {
    const { context, lines } = setup(['out', 'fine']);
    await listCommand(context, {
      probe: (accts) =>
        Promise.resolve(accts.map((a) => ({ name: a.name, loggedIn: a.name !== 'out' }))) as never,
    });
    const byName = new Map(rows(lines).map((r) => [r.name, r.loggedIn]));
    expect(byName.get('out')).toBe('no');
    expect(byName.get('fine')).toBe('yes');
  });
});

describe('ccx list and tags', () => {
  it('carries each account tags, an empty list for one with none', async () => {
    const { ctx, context, lines } = setup(['lent', 'plain']);
    updateAccount('lent', { tags: ['bot', 'pat'] }, ctx);
    await listCommand(context, { probe: (accts) => allSignedIn(accts) });
    const byName = new Map(
      (JSON.parse(lines.join('\n')) as { accounts: Array<{ name: string; tags: string[] }> }).accounts.map((r) => [r.name, r.tags]),
    );
    expect(byName.get('lent')).toEqual(['bot', 'pat']);
    expect(byName.get('plain')).toEqual([]);
  });

  it('shows only the accounts carrying every tag given, and says so when none does', async () => {
    const { ctx, context, lines } = setup(['lent', 'plain']);
    updateAccount('lent', { tags: ['pat'] }, ctx);
    expect(await listCommand(context, { probe: (accts) => allSignedIn(accts) }, { tagged: ['PAT'] })).toBe(0);
    expect(rows(lines).map((r) => r.name)).toEqual(['lent']);
    lines.length = 0;
    expect(await listCommand(context, { probe: (accts) => allSignedIn(accts) }, { tagged: ['bob'] })).toBe(1);
    // Asked for JSON, the refusal is JSON too: prose is a parse error for the reader.
    expect(JSON.parse(lines.join('\n'))).toEqual({
      schemaVersion: 1,
      accounts: [],
      error: 'no account carries #bob (tags in use: #pat)',
    });
    lines.length = 0;
    await listCommand({ ...context, json: false }, { probe: (accts) => allSignedIn(accts) }, { tagged: ['bob'] });
    expect(lines).toEqual(['no account carries #bob (tags in use: #pat)']);
  });

  it('has a TAGS column in the table', async () => {
    const { ctx, context, lines } = setup(['lent', 'plain']);
    updateAccount('lent', { tags: ['pat'] }, ctx);
    await listCommand({ ...context, json: false }, { probe: (accts) => allSignedIn(accts) });
    const table = lines.join('\n');
    expect(table).toMatch(/TAGS/);
    expect(table.split('\n').find((l) => l.includes('lent'))).toContain('#pat');
  });
});
