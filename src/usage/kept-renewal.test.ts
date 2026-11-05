import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { refreshCredentialIfExpired } from './oauth-refresh.js';
import { refreshUsage } from './usage-store.js';
import { forgetRefusals } from './dead-login-memo.js';
import { doctorCommand } from '../commands/doctor.js';
import { addAccount } from '../accounts/registry.js';
import { loadConfig } from '../config/config.js';
import { takeLease } from '../session/lease.js';
import { sha256Fingerprint } from '../util/fingerprint.js';
import type { CliContext } from '../context.js';

/**
 * A renewal retires the login it renews with Anthropic before the new one is
 * saved. When the save failed, the account was lost (issue #186). These run
 * a renewal whose Keychain save fails, then the next look at the account.
 *
 * The Keychain is a map here, never the real one, and every save to it can be
 * made to fail.
 */
const keychain = vi.hoisted(() => ({ items: new Map<string, string>(), failSaves: 0 }));
vi.mock('../accounts/keychain.js', () => {
  const read = vi.fn((dir: string) => keychain.items.get(dir) ?? null);
  const write = vi.fn((dir: string, text: string) => {
    if (keychain.failSaves > 0) {
      keychain.failSaves -= 1;
      throw new Error('Could not save the profile login in macOS Keychain');
    }
    keychain.items.set(dir, text);
  });
  const remove = vi.fn((dir: string) => {
    keychain.items.delete(dir);
  });
  return {
    keychainService: (dir: string) => `Claude Code-credentials-${dir}`,
    readKeychainCredential: read,
    writeKeychainCredential: write,
    deleteKeychainCredential: remove,
    readKeychainCredentialAsync: async (dir: string) => read(dir),
    writeKeychainCredentialAsync: async (dir: string, text: string) => write(dir, text),
    deleteKeychainCredentialAsync: async (dir: string) => remove(dir),
  };
});

const NOW = 1_800_000_000_000;
const now = (): number => NOW;
const HOUR = 3_600_000;
const KEPT = '.credentials.renewed.json';

/** MCP sign-ins long enough to take the login past one line of `security -i` (#179), as the ones that broke were. */
const mcp = (generation: number): Record<string, unknown> => ({
  'notion|1': {
    accessToken: `mcp-access-${generation}-${'n'.repeat(2_400)}`,
    refreshToken: `mcp-refresh-${generation}-${'n'.repeat(2_400)}`,
  },
});
const loginText = (refresh: string, expiresAt: number, sign = mcp(1)): string =>
  JSON.stringify({
    claudeAiOauth: { accessToken: `a-${refresh}`, refreshToken: refresh, expiresAt, scopes: ['user:inference'] },
    mcpOAuth: sign,
  });
/** What a renewal of `before` makes of it: the token endpoint's new tokens, everything else as it was. */
const renewalOf = (before: string, access: string, refresh: string): string => {
  const parsed = JSON.parse(before) as { claudeAiOauth: Record<string, unknown> };
  return JSON.stringify({
    ...parsed,
    claudeAiOauth: { ...parsed.claudeAiOauth, accessToken: access, refreshToken: refresh, expiresAt: NOW + 8 * HOUR },
  });
};
const refreshTokenOf = (text: string | undefined): string | null => {
  try {
    return (JSON.parse(text ?? '') as { claudeAiOauth?: { refreshToken?: string } }).claudeAiOauth?.refreshToken ?? null;
  } catch {
    return null;
  }
};

/**
 * Anthropic's token endpoint as a renewal meets it: each refresh token works
 * once, and the one it renews is retired at that moment.
 */
function tokenEndpoint(first: string): { fetchImpl: typeof fetch; sent: string[] } {
  const live = new Set([first]);
  const sent: string[] = [];
  let issued = 0;
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    const token = (JSON.parse(String(init?.body)) as { refresh_token: string }).refresh_token;
    sent.push(token);
    if (!live.delete(token)) {
      return new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token not found or invalid' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    issued += 1;
    const next = `r-${issued + 1}`;
    live.add(next);
    return new Response(
      JSON.stringify({ access_token: `a-renewed-${issued}`, refresh_token: next, expires_in: 8 * 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

function home(): { root: string; ctx: { env: NodeJS.ProcessEnv } } {
  const root = mkdtempSync(path.join(tmpdir(), 'cas-kept-renewal-'));
  return { root, ctx: { env: { CLAUDE_AUTO_SWITCH_HOME: root, HOME: root, USERPROFILE: root } } };
}

/** A profile whose login lives in the Keychain, as Claude keeps it on a Mac. */
function profile(root: string, name: string, login: string): string {
  const dir = path.join(root, 'profiles', name);
  mkdirSync(dir, { recursive: true });
  keychain.items.set(dir, login);
  return dir;
}

/** Renew the login in `dir` with its save to the Keychain failing, whatever the outcome. */
async function renewWithSaveFailing(dir: string, endpoint: { fetchImpl: typeof fetch }): Promise<string> {
  keychain.failSaves = 1;
  try {
    const outcome = await refreshCredentialIfExpired(dir, { now, fetchImpl: endpoint.fetchImpl });
    return outcome.status;
  } catch (error) {
    return `threw: ${String(error)}`;
  } finally {
    keychain.failSaves = 0;
  }
}

beforeEach(() => {
  keychain.items.clear();
  keychain.failSaves = 0;
  // Every test starts its logins from the same texts, so a refusal one meets must not follow into the next.
  forgetRefusals();
});

describe('a renewal whose save fails', () => {
  it('is kept on disk, owner-only, and the next renewal check saves it whole without sending the retired token', async () => {
    const { root } = home();
    const before = loginText('r-1', NOW - HOUR);
    const dir = profile(root, 'one', before);
    const endpoint = tokenEndpoint('r-1');

    const first = await renewWithSaveFailing(dir, endpoint);

    // Anthropic renewed it and retired r-1; the Keychain refused the renewal.
    expect(endpoint.sent).toEqual(['r-1']);
    expect(refreshTokenOf(keychain.items.get(dir))).toBe('r-1');
    const kept = path.join(dir, KEPT);
    expect(existsSync(kept)).toBe(true);
    expect(readFileSync(kept, 'utf8')).toContain('r-2');
    if (process.platform !== 'win32') expect(statSync(kept).mode & 0o777).toBe(0o600);
    expect(first).toBe('unavailable');

    const second = await refreshCredentialIfExpired(dir, { now, fetchImpl: endpoint.fetchImpl });

    expect(endpoint.sent).toEqual(['r-1']);
    const saved = keychain.items.get(dir) ?? '';
    expect(saved).toBe(renewalOf(before, 'a-renewed-1', 'r-2'));
    expect(saved.length).toBeGreaterThan(4_096);
    expect(existsSync(kept)).toBe(false);
    expect(second.status).toBe('refreshed');

    // A renewal whose save works leaves nothing kept.
    const later = await refreshCredentialIfExpired(dir, { now: () => NOW + 8 * HOUR, fetchImpl: endpoint.fetchImpl });
    expect(later.status).toBe('refreshed');
    expect(refreshTokenOf(keychain.items.get(dir))).toBe('r-3');
    expect(existsSync(kept)).toBe(false);
  });

  it('is saved over the login it retired even when that one says it has longer left, as a token turned away does', async () => {
    const { root } = home();
    // Revoked hours before its stored expiry: the usage endpoint turned it away.
    const before = loginText('r-1', NOW + 9 * HOUR);
    const dir = profile(root, 'one', before);
    const endpoint = tokenEndpoint('r-1');
    keychain.failSaves = 1;
    await refreshCredentialIfExpired(dir, {
      now,
      fetchImpl: endpoint.fetchImpl,
      renewRejected: sha256Fingerprint('a-r-1'),
    }).catch(() => undefined);
    keychain.failSaves = 0;
    expect(endpoint.sent).toEqual(['r-1']);

    await refreshCredentialIfExpired(dir, { now, fetchImpl: endpoint.fetchImpl });

    expect(keychain.items.get(dir)).toBe(renewalOf(before, 'a-renewed-1', 'r-2'));
    expect(existsSync(path.join(dir, KEPT))).toBe(false);
  });

  it('is saved whole, its MCP sign-ins with it, where the store holds no login any more', async () => {
    const { root } = home();
    const before = loginText('r-1', NOW - HOUR);
    const dir = profile(root, 'one', before);
    const endpoint = tokenEndpoint('r-1');
    await renewWithSaveFailing(dir, endpoint);
    expect(existsSync(path.join(dir, KEPT))).toBe(true);
    // The Keychain item is gone, and the file holds nothing.
    keychain.items.delete(dir);
    writeFileSync(path.join(dir, '.credentials.json'), '{}', 'utf8');

    await refreshCredentialIfExpired(dir, { now, fetchImpl: endpoint.fetchImpl });

    expect(readFileSync(path.join(dir, '.credentials.json'), 'utf8')).toBe(renewalOf(before, 'a-renewed-1', 'r-2'));
    expect(existsSync(path.join(dir, KEPT))).toBe(false);
  });

  it('is never saved over a login with no expiry put there since', async () => {
    const { root } = home();
    const dir = profile(root, 'one', loginText('r-1', NOW - HOUR));
    const endpoint = tokenEndpoint('r-1');
    await renewWithSaveFailing(dir, endpoint);
    expect(existsSync(path.join(dir, KEPT))).toBe(true);
    const apiKey = JSON.stringify({ primaryApiKey: 'sk-ant-api-fake' });
    keychain.items.set(dir, apiKey);

    await refreshCredentialIfExpired(dir, { now, fetchImpl: endpoint.fetchImpl });

    expect(keychain.items.get(dir)).toBe(apiKey);
    expect(existsSync(path.join(dir, KEPT))).toBe(false);
  });

  it('is saved by the next usage refresh, for an account a session is on as well, and carried to a profile that shared the login', async () => {
    const { root, ctx } = home();
    const before = loginText('r-1', NOW - HOUR);
    const one = profile(root, 'one', before);
    const copy = profile(root, 'copy', before);
    const accounts = [
      { name: 'one', dir: one, email: 'one@example.com' },
      { name: 'copy', dir: copy, email: 'one@example.com' },
    ];
    const endpoint = tokenEndpoint('r-1');
    vi.stubGlobal('fetch', endpoint.fetchImpl);
    try {
      await renewWithSaveFailing(one, endpoint);
      expect(existsSync(path.join(one, KEPT))).toBe(true);
      // A session is on it, so the refresh renews neither profile: saving the
      // renewal is what keeps that session's next renewal from failing.
      takeLease('one', path.join(root, 'a-session'), ctx);

      await refreshUsage(accounts, ctx, {
        maxAgeMs: 0,
        gapMs: 0,
        now,
        probe: () => Promise.resolve({ verdict: 'allowed', fiveHour: 0.1, sevenDay: 0.1 }),
      });

      expect(refreshTokenOf(keychain.items.get(one))).toBe('r-2');
      expect(refreshTokenOf(keychain.items.get(copy))).toBe('r-2');
      expect(existsSync(path.join(one, KEPT))).toBe(false);
      // The retired token was never sent again, from either profile.
      expect(endpoint.sent).toEqual(['r-1']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is waited for, sending nothing, while its save goes on failing', async () => {
    const { root } = home();
    const before = loginText('r-1', NOW - HOUR);
    const dir = profile(root, 'one', before);
    const endpoint = tokenEndpoint('r-1');
    await renewWithSaveFailing(dir, endpoint);
    expect(existsSync(path.join(dir, KEPT))).toBe(true);

    // The Keychain refuses the next save too.
    const again = await renewWithSaveFailing(dir, endpoint);

    // The stored login is the one the renewal retired: renewing it would send a spent token.
    expect(endpoint.sent).toEqual(['r-1']);
    expect(again).toBe('unavailable');
    expect(existsSync(path.join(dir, KEPT))).toBe(true);
    expect(refreshTokenOf(keychain.items.get(dir))).toBe('r-1');

    // Its lock held by something renewing it now: said so, and nothing sent.
    const lock = path.join(dir, '.oauth_refresh.lock');
    mkdirSync(lock);
    const held = await refreshCredentialIfExpired(dir, { now, fetchImpl: endpoint.fetchImpl, lockWaitMs: 0 });
    rmSync(lock, { recursive: true, force: true });
    expect(held.status).toBe('busy');
    expect(endpoint.sent).toEqual(['r-1']);

    const third = await refreshCredentialIfExpired(dir, { now, fetchImpl: endpoint.fetchImpl });
    expect(third.status).toBe('refreshed');
    expect(keychain.items.get(dir)).toBe(renewalOf(before, 'a-renewed-1', 'r-2'));
    expect(endpoint.sent).toEqual(['r-1']);
  });

  it('is dropped, never saved, once a newer login is stored', async () => {
    const { root } = home();
    const dir = profile(root, 'one', loginText('r-1', NOW - HOUR));
    const endpoint = tokenEndpoint('r-1');
    await renewWithSaveFailing(dir, endpoint);
    expect(existsSync(path.join(dir, KEPT))).toBe(true);
    // Signed in again since: a login of its own, issued after the renewal.
    const signedIn = loginText('r-signed-in', NOW + 9 * HOUR);
    keychain.items.set(dir, signedIn);

    const outcome = await refreshCredentialIfExpired(dir, { now, fetchImpl: endpoint.fetchImpl });

    expect(existsSync(path.join(dir, KEPT))).toBe(false);
    expect(keychain.items.get(dir)).toBe(signedIn);
    expect(outcome.status).toBe('not-needed');
  });

  it('keeps the MCP sign-ins the store holds now, which may be newer than the ones it renewed with', async () => {
    const { root } = home();
    const before = loginText('r-1', NOW - HOUR);
    const dir = profile(root, 'one', before);
    const endpoint = tokenEndpoint('r-1');
    await renewWithSaveFailing(dir, endpoint);
    // A session parked a newer MCP sign-in in the stored login meanwhile.
    keychain.items.set(dir, loginText('r-1', NOW - HOUR, mcp(2)));

    await refreshCredentialIfExpired(dir, { now, fetchImpl: endpoint.fetchImpl });

    const saved = JSON.parse(keychain.items.get(dir) ?? '{}') as { claudeAiOauth?: unknown; mcpOAuth?: unknown };
    expect(saved.claudeAiOauth).toEqual(
      (JSON.parse(renewalOf(before, 'a-renewed-1', 'r-2')) as { claudeAiOauth: unknown }).claudeAiOauth,
    );
    expect(saved.mcpOAuth).toEqual(mcp(2));
    expect(endpoint.sent).toEqual(['r-1']);
  });
});

describe('ccx doctor and a renewal whose save failed', () => {
  const deps = {
    gitTracked: () => null,
    resolveClaude: () => ({ bin: '/real/claude' }),
    checkBrowserPort: () => Promise.resolve(true),
    shellPlans: [],
    skipNetwork: true,
  };
  afterEach(() => vi.unstubAllGlobals());

  /** A ccx whose `claude auth status` answers signed out, without running Claude. */
  function context(ctx: { env: NodeJS.ProcessEnv }, lines: string[]): CliContext {
    return {
      ctx,
      config: loadConfig(ctx),
      claude: { bin: process.execPath, prefixArgs: ['-e', 'console.log(JSON.stringify({ loggedIn: false }))'] },
      out: (m) => lines.push(m),
      json: false,
      quiet: false,
    };
  }

  it('names the account whose renewal is waiting, and the fix', async () => {
    const { root, ctx } = home();
    const dir = profile(root, 'one', loginText('r-1', NOW - HOUR));
    addAccount({ name: 'one', dir, enabled: true }, ctx);
    await renewWithSaveFailing(dir, tokenEndpoint('r-1'));
    const lines: string[] = [];

    expect(await doctorCommand(context(ctx, lines), deps)).toBe(1);

    const out = lines.join('\n');
    expect(out).toContain('renewed, but not yet saved where Claude reads them: one');
    expect(out).toContain('ccx doctor --fix');
  });

  it('--fix saves it over a login cut short, rather than putting back the one it retired', async () => {
    const { root, ctx } = home();
    const before = loginText('r-1', NOW - HOUR);
    const dir = profile(root, 'one', before);
    addAccount({ name: 'one', dir, enabled: true }, ctx);
    await renewWithSaveFailing(dir, tokenEndpoint('r-1'));
    // What a save through `security -i` before 2.6.26 left: the login cut at 2,008 characters.
    keychain.items.set(dir, before.slice(0, 2_008));
    expect(readFileSync(path.join(dir, '.credentials.prev.json'), 'utf8')).toBe(before);

    await doctorCommand(context(ctx, []), deps, { fix: true });

    expect(keychain.items.get(dir)).toBe(renewalOf(before, 'a-renewed-1', 'r-2'));
    expect(existsSync(path.join(dir, KEPT))).toBe(false);
  });

  it('counts the kept file as a login in its git check', async () => {
    const { root, ctx } = home();
    const claude = path.join(root, '.claude');
    mkdirSync(claude, { recursive: true });
    writeFileSync(path.join(claude, KEPT), '{}', 'utf8');
    const lines: string[] = [];

    const code = await doctorCommand(context(ctx, lines), {
      ...deps,
      gitTracked: (folder: string) => (folder === claude ? { repo: claude, files: [KEPT] } : null),
    });

    expect(lines.join('\n')).toContain(`tracks 1 login file: ${KEPT}`);
    expect(code).toBe(1);
  });
});
