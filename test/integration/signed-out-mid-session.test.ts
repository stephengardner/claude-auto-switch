import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeTerminal } from './terminal-probe.js';
import { addCommand } from '../../src/commands/add.js';
import { runCommand } from '../../src/commands/run.js';
import { setActive } from '../../src/state/active.js';
import { loadConfig } from '../../src/config/config.js';
import { configHome } from '../../src/config/paths.js';
import { readEvents } from '../../src/events/log.js';
import { hasWorkingLogin } from '../../src/accounts/account-login.js';
import type { CliContext } from '../../src/context.js';
import { loginServer, signIn, type LoginServer } from './login-server.js';

/**
 * A login revoked while a session is running on it: signed out at claude.ai,
 * or the account put on hold. Claude says "Please run /login" and can do
 * nothing more. ccx reads that from the conversation's record, asks the token
 * endpoint whether the login is finished, and when it is, writes that down (so
 * the account leaves rotation) and carries the conversation on to another
 * account. When the login turns out to work, nothing moves.
 *
 * Real sessions in a pseudo-terminal against the fake claude, with the two
 * requests ccx makes, the usage read and the renewal, answered by the login
 * server in login-server.ts.
 */

const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));
const CONVERSATION = '77777777-6666-4777-8888-999999999999';

function makeContext(home: string, server: LoginServer): CliContext {
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  return {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    verifyCap: () => Promise.resolve('allowed'),
    loginProbe: server.loginProbe,
    refuteBackoffMs: 500,
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
  };
}

async function loginAccount(context: CliContext, home: string, name: string): Promise<string> {
  const dir = path.join(home, 'profiles', name);
  await addCommand(context, name, { dir, login: false });
  mkdirSync(dir, { recursive: true });
  signIn(dir, name);
  return dir;
}

interface RunEntry {
  type: string;
  args?: string[];
  marker: string | null;
}

function launchesIn(runsLog: string): RunEntry[] {
  if (!existsSync(runsLog)) return [];
  return readFileSync(runsLog, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as RunEntry)
    .filter((r) => r.type === 'launch');
}

const terminal = probeTerminal();
const PTY_AVAILABLE = terminal.open;
const ptyProblem = terminal.problem;
if (!PTY_AVAILABLE && !process.env.CI)
  console.warn(`[skipped] signed-out tests: no pseudo-terminal here (${ptyProblem}).`);

const FAKE_ENV = [
  'FAKE_CLAUDE_IDLE_MS',
  'FAKE_CLAUDE_RUNS_LOG',
  'FAKE_CLAUDE_SESSION_RECORD',
  'FAKE_CLAUDE_TRANSCRIPT',
  'FAKE_CLAUDE_REFUSE_AFTER_MS',
  'FAKE_CLAUDE_REFUSE_AS',
  'FAKE_CLAUDE_REFUSE_ON',
];

describe.skipIf(!PTY_AVAILABLE && !process.env.CI)('a login revoked while a session is running on it', () => {
  afterEach(() => {
    for (const name of FAKE_ENV) delete process.env[name];
    vi.unstubAllGlobals();
  });

  it(
    'takes the account out of rotation and carries the conversation on to another one',
    { timeout: 60_000 },
    async () => {
      const home = mkdtempSync(path.join(tmpdir(), 'cas-signed-out-'));
      const runsLog = path.join(home, 'runs.jsonl');
      Object.assign(process.env, {
        FAKE_CLAUDE_RUNS_LOG: runsLog,
        FAKE_CLAUDE_IDLE_MS: '6000',
        FAKE_CLAUDE_SESSION_RECORD: '1',
        FAKE_CLAUDE_TRANSCRIPT: '1',
        FAKE_CLAUDE_REFUSE_AFTER_MS: '2500',
        FAKE_CLAUDE_REFUSE_AS: 'signed-out',
        FAKE_CLAUDE_REFUSE_ON: 'A',
      });
      const server = loginServer();
      const context = makeContext(home, server);
      const dirA = await loginAccount(context, home, 'A');
      await loginAccount(context, home, 'B');
      setActive('A', context.ctx);
      // Signed out at claude.ai once the session is under way: from then on
      // the API turns A's token away and will not renew its login.
      setTimeout(() => server.signOut('A'), 1_500);

      expect(await runCommand(context, ['--resume', CONVERSATION])).toBe(0);

      const launches = launchesIn(runsLog);
      expect(launches.map((l) => l.marker)).toEqual(['A', 'B']);
      // The same conversation, carried on.
      expect(launches[1]?.args).toContain(CONVERSATION);
      // Written down where every part of ccx looks, and said where the dashboard shows it.
      expect(hasWorkingLogin(dirA, context.ctx)).toBe(false);
      const said = readEvents(configHome(context.ctx), 50).filter((e) => e.kind === 'signed-out');
      expect(said.map((e) => e.msg)).toEqual(['"A" was signed out, so it is out of rotation until it is signed in again']);
    },
  );

  it('still carries on elsewhere when Claude exits before the check comes back', { timeout: 60_000 }, async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-signed-out-exit-'));
    const runsLog = path.join(home, 'runs.jsonl');
    Object.assign(process.env, {
      FAKE_CLAUDE_RUNS_LOG: runsLog,
      // Gone 200 ms after it says "Please run /login", well before the answer.
      FAKE_CLAUDE_IDLE_MS: '2700',
      FAKE_CLAUDE_SESSION_RECORD: '1',
      FAKE_CLAUDE_TRANSCRIPT: '1',
      FAKE_CLAUDE_REFUSE_AFTER_MS: '2500',
      FAKE_CLAUDE_REFUSE_AS: 'signed-out',
      FAKE_CLAUDE_REFUSE_ON: 'A',
    });
    const server = loginServer({ slowMs: 2_000 });
    const context = makeContext(home, server);
    const dirA = await loginAccount(context, home, 'A');
    await loginAccount(context, home, 'B');
    setActive('A', context.ctx);
    setTimeout(() => server.signOut('A'), 1_500);

    expect(await runCommand(context, ['--resume', CONVERSATION])).toBe(0);

    expect(launchesIn(runsLog).map((l) => l.marker)).toEqual(['A', 'B']);
    expect(hasWorkingLogin(dirA, context.ctx)).toBe(false);
  });

  it('never starts on an account signed out before the session, however long its login says it has', { timeout: 60_000 }, async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-signed-out-before-'));
    const runsLog = path.join(home, 'runs.jsonl');
    Object.assign(process.env, { FAKE_CLAUDE_RUNS_LOG: runsLog, FAKE_CLAUDE_IDLE_MS: '1500' });
    const server = loginServer();
    const context = makeContext(home, server);
    const dirA = await loginAccount(context, home, 'A');
    await loginAccount(context, home, 'B');
    setActive('A', context.ctx);
    server.signOut('A');

    expect(await runCommand(context, [])).toBe(0);

    expect(launchesIn(runsLog).map((l) => l.marker)).toEqual(['B']);
    expect(hasWorkingLogin(dirA, context.ctx)).toBe(false);
  });

  it('moves nothing when the login turns out to work', { timeout: 60_000 }, async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-signed-out-works-'));
    const runsLog = path.join(home, 'runs.jsonl');
    Object.assign(process.env, {
      FAKE_CLAUDE_RUNS_LOG: runsLog,
      FAKE_CLAUDE_IDLE_MS: '5000',
      FAKE_CLAUDE_SESSION_RECORD: '1',
      FAKE_CLAUDE_TRANSCRIPT: '1',
      FAKE_CLAUDE_REFUSE_AFTER_MS: '2500',
      FAKE_CLAUDE_REFUSE_AS: 'signed-out',
    });
    const context = makeContext(home, loginServer());
    const dirA = await loginAccount(context, home, 'A');
    await loginAccount(context, home, 'B');
    setActive('A', context.ctx);

    expect(await runCommand(context, ['--resume', CONVERSATION])).toBe(0);

    expect(launchesIn(runsLog).map((l) => l.marker)).toEqual(['A']);
    expect(hasWorkingLogin(dirA, context.ctx)).toBe(true);
  });
});
