import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from '../../src/commands/run.js';
import { addAccount } from '../../src/accounts/registry.js';
import { setActive } from '../../src/state/active.js';
import { loadConfig } from '../../src/config/config.js';
import { sessionDirFor } from '../../src/session/session-dir.js';
import { liveLeases } from '../../src/session/lease.js';
import { configHome } from '../../src/config/paths.js';
import { readEvents } from '../../src/events/log.js';
import { writeSwitchRequest } from '../../src/state/switch-request.js';
import type { CliContext } from '../../src/context.js';
import {
  FAKE_ENV,
  PTY_AVAILABLE,
  fakeClaude,
  freshUsage,
  launches,
  readLog,
} from './typeable-claude.js';

/**
 * A terminal session's MCP logins, through a switch and to the end: it keeps its
 * own while it moves between accounts, parks them in the account it ends on, and
 * the next session on that account starts from them. The Keychain is a map here,
 * never the real one.
 */
const keychain = vi.hoisted(() => new Map<string, string>());
vi.mock('../../src/accounts/keychain.js', () => {
  const read = vi.fn((dir: string) => keychain.get(dir) ?? null);
  const write = vi.fn((dir: string, text: string) => {
    keychain.set(dir, text);
  });
  const remove = vi.fn((dir: string) => {
    keychain.delete(dir);
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const HOURS = 3_600_000;
const mcp = (n: number) => ({
  'notion|1': {
    serverName: 'notion',
    accessToken: `mcp-access-fake-${n}`,
    refreshToken: `mcp-refresh-fake-${n}`,
  },
});
/** Sign-ins to a second server, so a merge per server can be told from one that replaces the lot. */
const datadog = (n: number) => ({
  'datadog|2': {
    serverName: 'datadog',
    accessToken: `dd-access-fake-${n}`,
    refreshToken: `dd-refresh-fake-${n}`,
  },
});
const login = (name: string, mcpOAuth?: unknown): string =>
  JSON.stringify({
    account: name,
    claudeAiOauth: {
      accessToken: `a-${name}-1`,
      refreshToken: `r-${name}-1`,
      expiresAt: Date.now() + 8 * HOURS,
    },
    ...(mcpOAuth === undefined ? {} : { mcpOAuth }),
  });
const read = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const tokenOf = (text: string | null): string | null => {
  try {
    return (
      (JSON.parse(text ?? '') as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth
        ?.accessToken ?? null
    );
  } catch {
    return null;
  }
};
const mcpOf = (text: string | null): unknown => {
  try {
    return (JSON.parse(text ?? '') as { mcpOAuth?: unknown }).mcpOAuth;
  } catch {
    return undefined;
  }
};
/** Until `ok` says so or `ms` have passed; never throws, so what was reached is asserted on afterwards. */
async function until(ok: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok() && Date.now() < deadline) await sleep(25);
}

interface Scene {
  home: string;
  context: CliContext;
  runsLog: string;
  exitClaude: string;
  /** The saved login of an account, as ccx keeps it. */
  saved: (name: string) => string | null;
  /** The login in the folder this process's session runs on. */
  session: () => string | null;
}

/** Two accounts, each saved with MCP logins parked by a session that ended. */
function scene(): Scene {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-mcp-logins-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    verifyCap: () => Promise.resolve('allowed'),
    loginProbe: () => Promise.resolve({ verdict: 'unknown' as const }),
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
  };
  context.config.resume.auto = false;
  const dirOf = (name: string): string => path.join(home, 'profiles', name);
  for (const [name, parked] of [
    ['A', 1],
    ['B', 2],
  ] as const) {
    mkdirSync(dirOf(name), { recursive: true });
    addAccount({ name, dir: dirOf(name), email: `${name.toLowerCase()}@example.com` }, ctx);
    writeFileSync(path.join(dirOf(name), '.credentials.json'), login(name, mcp(parked)));
    writeFileSync(
      path.join(dirOf(name), '.claude.json'),
      JSON.stringify({
        oauthAccount: {
          emailAddress: `${name.toLowerCase()}@example.com`,
          accountUuid: `uuid-${name}`,
        },
      }),
    );
  }
  freshUsage(home, ['A', 'B']);
  setActive('A', ctx);
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 404 })));
  const exitClaude = path.join(home, 'claude-exit');
  const runsLog = path.join(home, 'runs.jsonl');
  Object.assign(process.env, {
    FAKE_CLAUDE_RUNS_LOG: runsLog,
    FAKE_CLAUDE_IDLE_MS: '60000',
    FAKE_CLAUDE_EXIT_WHEN: exitClaude,
  });
  return {
    home,
    context,
    runsLog,
    exitClaude,
    saved: (name) => read(path.join(dirOf(name), '.credentials.json')),
    session: () => read(path.join(sessionDirFor(process.pid, ctx), '.credentials.json')),
  };
}

describe.skipIf(!PTY_AVAILABLE && !process.env.CI)("a terminal session's MCP logins", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const name of FAKE_ENV) delete process.env[name];
    keychain.clear();
  });

  it(
    'keeps the session its own through a switch, parks them in the account it ends on, and starts the next session with them',
    { timeout: 90_000 },
    async () => {
      const s = scene();
      const running = runCommand(s.context, []);
      await until(() => launches(readLog(s.runsLog)).length >= 1, 30_000);
      // A new session starts with the MCP logins parked in the account it starts on.
      expect(tokenOf(s.session())).toBe('a-A-1');
      expect(mcpOf(s.session())).toEqual(mcp(1));

      // Its Claude renews A's login and the person signs in to another MCP server, which Claude keeps beside it.
      const file = path.join(sessionDirFor(process.pid, s.context.ctx), '.credentials.json');
      const renewed = JSON.parse(login('A')) as { claudeAiOauth: Record<string, unknown> };
      renewed.claudeAiOauth.accessToken = 'a-A-2';
      renewed.claudeAiOauth.refreshToken = 'r-A-2';
      writeFileSync(file, JSON.stringify({ ...renewed, mcpOAuth: mcp(3) }));
      writeSwitchRequest('B', Date.now(), 'seamless', s.context.ctx, process.pid);
      await until(() => tokenOf(s.session()) === 'a-B-1', 30_000);

      // The session is on B with its own MCP logins, not the ones parked in B.
      expect(tokenOf(s.session())).toBe('a-B-1');
      expect(mcpOf(s.session())).toEqual(mcp(3));
      // A's renewal was saved home as the session left it, and A keeps the MCP logins parked in it.
      expect(tokenOf(s.saved('A'))).toBe('a-A-2');
      expect(mcpOf(s.saved('A'))).toEqual(mcp(1));
      expect(mcpOf(s.saved('B'))).toEqual(mcp(2));

      writeFileSync(s.exitClaude, '');
      expect(await running).toBe(0);

      // At its end the session parks its MCP logins in the account it ended on, and A's stay as they were.
      expect(tokenOf(s.saved('B'))).toBe('a-B-1');
      expect(mcpOf(s.saved('B'))).toEqual(mcp(3));
      expect(mcpOf(s.saved('A'))).toEqual(mcp(1));

      // The next session on B starts with them.
      rmSync(s.exitClaude, { force: true });
      setActive('B', s.context.ctx);
      const next = runCommand(s.context, []);
      await until(() => launches(readLog(s.runsLog)).length >= 2, 30_000);
      expect(tokenOf(s.session())).toBe('a-B-1');
      expect(mcpOf(s.session())).toEqual(mcp(3));
      writeFileSync(s.exitClaude, '');
      expect(await next).toBe(0);
    },
  );

  it(
    'does not take from the account the MCP logins another session parked there, when it signed in to none and ends',
    { timeout: 90_000 },
    async () => {
      const s = scene();
      const running = runCommand(s.context, []);
      await until(() => launches(readLog(s.runsLog)).length >= 1, 30_000);
      // This session never signed in to an MCP server: its login holds none.
      const file = path.join(sessionDirFor(process.pid, s.context.ctx), '.credentials.json');
      const bare = JSON.parse(s.session() ?? '{}') as Record<string, unknown>;
      delete bare.mcpOAuth;
      writeFileSync(file, JSON.stringify(bare));
      // Another session on A ended meanwhile, and parked its MCP logins there.
      writeFileSync(path.join(s.home, 'profiles', 'A', '.credentials.json'), login('A', mcp(5)));

      writeFileSync(s.exitClaude, '');
      expect(await running).toBe(0);

      expect(mcpOf(s.saved('A'))).toEqual(mcp(5));
    },
  );
  it(
    'keeps the sign-ins another folder parked for other servers, when it ends with its own',
    { timeout: 90_000 },
    async () => {
      const s = scene();
      const running = runCommand(s.context, []);
      await until(() => launches(readLog(s.runsLog)).length >= 1, 30_000);
      // This session signed in to Notion. The editor's folder, on the same account, ended meanwhile and parked Datadog.
      const file = path.join(sessionDirFor(process.pid, s.context.ctx), '.credentials.json');
      const own = JSON.parse(s.session() ?? '{}') as Record<string, unknown>;
      writeFileSync(file, JSON.stringify({ ...own, mcpOAuth: mcp(3) }));
      writeFileSync(
        path.join(s.home, 'profiles', 'A', '.credentials.json'),
        login('A', datadog(5)),
      );

      writeFileSync(s.exitClaude, '');
      expect(await running).toBe(0);

      expect(mcpOf(s.saved('A'))).toEqual({ ...datadog(5), ...mcp(3) });
    },
  );
  it(
    'keeps the sign-in another session refreshed and parked, when it ends holding the one it started from',
    { timeout: 90_000 },
    async () => {
      const s = scene();
      const at = (expiresAt: number, by: string) => ({
        'notion|1': {
          serverName: 'notion',
          accessToken: `mcp-access-fake-${by}`,
          refreshToken: `mcp-refresh-fake-${by}`,
          expiresAt,
        },
      });
      const T0 = Date.now() + 8 * HOURS;
      // Two terminals on A both start from the sign-in parked there.
      writeFileSync(
        path.join(s.home, 'profiles', 'A', '.credentials.json'),
        login('A', at(T0, 'S0')),
      );
      const running = runCommand(s.context, []);
      await until(() => launches(readLog(s.runsLog)).length >= 1, 30_000);
      expect(mcpOf(s.session())).toEqual(at(T0, 'S0'));
      // The other terminal refreshed it and ended, parking the refresh. This one never touched it.
      const T1 = T0 + 3_600_000;
      writeFileSync(
        path.join(s.home, 'profiles', 'A', '.credentials.json'),
        login('A', at(T1, 'S1')),
      );

      writeFileSync(s.exitClaude, '');
      expect(await running).toBe(0);

      expect(mcpOf(s.saved('A'))).toEqual(at(T1, 'S1'));
      expect(tokenOf(s.saved('A'))).toBe('a-A-1');
    },
  );

  describe('when the Claude login in the session is not one to save home', () => {
    /**
     * A session on A that has refreshed Notion's sign-in, which lives only in its folder
     * now: A's saved login holds the retired one. Nothing pulls A's login into the
     * folder meanwhile, as its Claude being busy refreshing would keep it from.
     */
    async function sessionHoldingARefresh(s: Scene) {
      const running = runCommand(s.context, []);
      await until(() => launches(readLog(s.runsLog)).length >= 1, 30_000);
      const folder = sessionDirFor(process.pid, s.context.ctx);
      mkdirSync(path.join(folder, '.oauth_refresh.lock'));
      return { running, folder, creds: path.join(folder, '.credentials.json') };
    }

    it(
      'parks its sign-ins when Claude signed out, and leaves the account its Claude login',
      { timeout: 90_000 },
      async () => {
        const s = scene();
        const { running, creds } = await sessionHoldingARefresh(s);
        writeFileSync(
          creds,
          JSON.stringify({
            account: 'A',
            claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 },
            mcpOAuth: mcp(3),
          }),
        );

        writeFileSync(s.exitClaude, '');
        expect(await running).toBe(0);

        expect(mcpOf(s.saved('A'))).toEqual(mcp(3));
        expect(tokenOf(s.saved('A'))).toBe('a-A-1');
      },
    );

    it(
      'parks its sign-ins when the session is signed in as someone else',
      { timeout: 90_000 },
      async () => {
        const s = scene();
        const { running, folder, creds } = await sessionHoldingARefresh(s);
        const state = path.join(folder, '.claude.json');
        writeFileSync(
          state,
          JSON.stringify({
            ...(JSON.parse(read(state) ?? '{}') as object),
            oauthAccount: { emailAddress: 'someone@example.com', accountUuid: 'uuid-someone' },
          }),
        );
        // The login in the session is the other account's, not A's.
        writeFileSync(creds, login('someone', mcp(3)));

        writeFileSync(s.exitClaude, '');
        expect(await running).toBe(0);

        expect(mcpOf(s.saved('A'))).toEqual(mcp(3));
        // A whole save would have written the session's login over A's.
        expect(tokenOf(s.saved('A'))).toBe('a-A-1');
      },
    );

    it(
      'ends all the same when they cannot be parked, and says so',
      { timeout: 90_000 },
      async () => {
        const s = scene();
        const { running, creds } = await sessionHoldingARefresh(s);
        writeFileSync(
          creds,
          JSON.stringify({
            account: 'A',
            claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 },
            mcpOAuth: mcp(3),
          }),
        );
        // Someone else is changing A's saved login.
        mkdirSync(path.join(s.home, 'profiles', 'A', '.oauth_refresh.lock'));

        writeFileSync(s.exitClaude, '');
        expect(await running).toBe(0);

        expect(liveLeases(s.context.ctx)).toEqual([]);
        expect(mcpOf(s.saved('A'))).toEqual(mcp(1));
        const said = readEvents(configHome(s.context.ctx), 100).map((e) => e.msg);
        expect(said.some((msg) => msg.includes("could not keep this session's MCP sign-ins"))).toBe(
          true,
        );
      },
    );
  });
});
