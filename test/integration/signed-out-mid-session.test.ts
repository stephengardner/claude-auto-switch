import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
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
import { takeLease } from '../../src/session/lease.js';
import type { CliContext } from '../../src/context.js';
import { loginServer, signIn, type LoginServer } from './login-server.js';
import { QUICK, TYPEABLE, launches, prompts, readLog } from './typeable-claude.js';

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
  'FAKE_CLAUDE_READS_INPUT',
  'FAKE_CLAUDE_STATUS',
  'FAKE_CLAUDE_EXIT_AFTER_PROMPTS',
  'FAKE_CLAUDE_EXIT_DELAY_MS',
  'FAKE_CLAUDE_SIGNED_OUT_SAYS',
];

interface LoggedEvent {
  msg: string;
  kind?: string;
  data?: Record<string, unknown>;
}
const eventsIn = (context: CliContext): LoggedEvent[] => readEvents(configHome(context.ctx), 200);

/**
 * A Claude that can be typed into, refused for its login on the accounts
 * `refuseOn` names (all of them when empty) 2.5 s in, in Claude's own words
 * when `says` is given, and done once it has answered one prompt.
 */
const typeableRefusedForLogin = (runsLog: string, refuseOn: string, says?: string): Record<string, string> => ({
  ...TYPEABLE,
  FAKE_CLAUDE_RUNS_LOG: runsLog,
  FAKE_CLAUDE_IDLE_MS: '20000',
  FAKE_CLAUDE_REFUSE_AFTER_MS: '2500',
  FAKE_CLAUDE_REFUSE_AS: 'signed-out',
  FAKE_CLAUDE_REFUSE_ON: refuseOn,
  FAKE_CLAUDE_EXIT_AFTER_PROMPTS: '1',
  ...(says ? { FAKE_CLAUDE_SIGNED_OUT_SAYS: says } : {}),
});

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

  it(
    'moves a signed-out session to another account in place and tells it to carry on',
    { timeout: 60_000 },
    async () => {
      const home = mkdtempSync(path.join(tmpdir(), 'cas-signed-out-in-place-'));
      const runsLog = path.join(home, 'runs.jsonl');
      Object.assign(process.env, typeableRefusedForLogin(runsLog, 'A'));
      const server = loginServer();
      const context = { ...makeContext(home, server), carryOn: QUICK };
      const dirA = await loginAccount(context, home, 'A');
      await loginAccount(context, home, 'B');
      setActive('A', context.ctx);
      setTimeout(() => server.signOut('A'), 1_500);

      expect(await runCommand(context, [])).toBe(0);

      const log = readLog(runsLog);
      // One Claude from start to finish: moved under it, never relaunched.
      expect(launches(log).map((l) => l.marker)).toEqual(['A']);
      expect(prompts(log)).toEqual([expect.objectContaining({ marker: 'B', refused: false })]);
      expect(hasWorkingLogin(dirA, context.ctx)).toBe(false);
      const events = eventsIn(context);
      expect(events.filter((e) => e.kind === 'signed-out').map((e) => e.msg)).toEqual([
        '"A" was signed out, so it is out of rotation until it is signed in again',
      ]);
      expect(events.filter((e) => e.kind === 'cap-relief').map((e) => e.data)).toEqual([
        expect.objectContaining({ from: 'A', to: 'B', login: 'finished' }),
      ]);
      // A login refused is no limit: nothing went on the ledger.
      expect(events.filter((e) => e.kind === 'capped')).toEqual([]);
    },
  );

  it(
    'moves it in place when nothing can be learned about the login, leaves the account in rotation, and asks again later',
    { timeout: 60_000 },
    async () => {
      const home = mkdtempSync(path.join(tmpdir(), 'cas-signed-out-unknown-'));
      const runsLog = path.join(home, 'runs.jsonl');
      Object.assign(process.env, typeableRefusedForLogin(runsLog, 'A'), {
        // Long enough after its answer for the second look to come round.
        FAKE_CLAUDE_EXIT_DELAY_MS: '3000',
      });
      const server = loginServer();
      // The usage endpoint rate limited, and the token endpoint out of reach for A.
      server.rateLimit();
      server.cutOff('A');
      const context = { ...makeContext(home, server), carryOn: QUICK, loginRecheckMs: 500 };
      const dirA = await loginAccount(context, home, 'A');
      await loginAccount(context, home, 'B');
      setActive('A', context.ctx);

      expect(await runCommand(context, [])).toBe(0);

      const log = readLog(runsLog);
      expect(launches(log).map((l) => l.marker)).toEqual(['A']);
      expect(prompts(log)).toEqual([expect.objectContaining({ marker: 'B', refused: false })]);
      // Not marked: nothing said A's login is finished.
      expect(hasWorkingLogin(dirA, context.ctx)).toBe(true);
      const events = eventsIn(context);
      expect(events.filter((e) => e.kind === 'signed-out')).toEqual([]);
      const checks = events.filter((e) => e.kind === 'signed-out-check');
      expect(checks[0]?.msg).toMatch(
        /^a turn on "A" was refused for its login, and ccx could not tell whether that login works, because .*could not be reached/,
      );
      expect(checks[0]?.data).toMatchObject({ account: 'A', outcome: 'unknown' });
      // Asked about again once the session had moved off it.
      expect(checks[1]?.data).toMatchObject({ account: 'A', outcome: 'unknown', attempt: 1 });
      expect(events.filter((e) => e.kind === 'cap-relief').map((e) => e.data)).toEqual([
        expect.objectContaining({ from: 'A', to: 'B', login: 'unknown' }),
      ]);
    },
  );

  it(
    'keeps a session with nowhere else to go where it is when nothing can be learned about its login, and says so',
    { timeout: 60_000 },
    async () => {
      const home = mkdtempSync(path.join(tmpdir(), 'cas-signed-out-alone-'));
      const runsLog = path.join(home, 'runs.jsonl');
      Object.assign(process.env, {
        FAKE_CLAUDE_RUNS_LOG: runsLog,
        FAKE_CLAUDE_IDLE_MS: '6000',
        FAKE_CLAUDE_SESSION_RECORD: '1',
        FAKE_CLAUDE_TRANSCRIPT: '1',
        FAKE_CLAUDE_REFUSE_AFTER_MS: '2500',
        FAKE_CLAUDE_REFUSE_AS: 'signed-out',
      });
      const server = loginServer();
      server.rateLimit();
      server.cutOff('A');
      const context = makeContext(home, server);
      const dirA = await loginAccount(context, home, 'A');
      setActive('A', context.ctx);

      expect(await runCommand(context, [])).toBe(0);

      // Not ended for it: it ran until Claude ended by itself.
      expect(launchesIn(runsLog).map((l) => l.marker)).toEqual(['A']);
      expect(hasWorkingLogin(dirA, context.ctx)).toBe(true);
      const checks = eventsIn(context).filter((e) => e.kind === 'signed-out-check');
      expect(checks.slice(0, 1)).toEqual([
        expect.objectContaining({
          msg: expect.stringMatching(/no other account can take this session, so it stays on "A"/),
          data: expect.objectContaining({ account: 'A', outcome: 'unknown', stayed: true }),
        }),
      ]);
    },
  );

  it(
    'renews a token Claude says has expired at the token endpoint, without the usage read, and carries on in place',
    { timeout: 60_000 },
    async () => {
      const home = mkdtempSync(path.join(tmpdir(), 'cas-signed-out-expired-'));
      const runsLog = path.join(home, 'runs.jsonl');
      Object.assign(
        process.env,
        typeableRefusedForLogin(runsLog, '', 'Please run /login · API Error: 401 OAuth access token has expired'),
      );
      const server = loginServer();
      server.rateLimit();
      const context = { ...makeContext(home, server), carryOn: QUICK };
      const dirA = await loginAccount(context, home, 'A');
      await loginAccount(context, home, 'B');
      setActive('A', context.ctx);

      expect(await runCommand(context, [])).toBe(0);

      const log = readLog(runsLog);
      // Carried on where it was, told to by the prompt.
      expect(launches(log).map((l) => l.marker)).toEqual(['A']);
      expect(prompts(log)).toEqual([expect.objectContaining({ marker: 'A', refused: false })]);
      expect(server.renewals).toContain('r-A');
      // Only the session start read usage, of the account's own login: the
      // check after the refusal went to the token endpoint alone.
      expect(server.reads.map((file) => path.basename(path.dirname(file)))).toEqual(['A']);
      expect(hasWorkingLogin(dirA, context.ctx)).toBe(true);
      expect(eventsIn(context).filter((e) => e.kind === 'signed-out-check').map((e) => e.data)).toEqual([
        { account: 'A', outcome: 'renewed' },
      ]);
    },
  );

  it(
    "says the login it took from a live session was dead too, never that it adopted a working one",
    { timeout: 60_000 },
    async () => {
      const home = mkdtempSync(path.join(tmpdir(), 'cas-signed-out-adopt-'));
      const runsLog = path.join(home, 'runs.jsonl');
      Object.assign(process.env, { FAKE_CLAUDE_RUNS_LOG: runsLog, FAKE_CLAUDE_IDLE_MS: '1500' });
      const server = loginServer();
      const context = makeContext(home, server);
      const dirA = path.join(home, 'profiles', 'A');
      await addCommand(context, 'A', { dir: dirA, login: false, email: 'a@example.com' });
      mkdirSync(dirA, { recursive: true });
      signIn(dirA, 'A');
      await loginAccount(context, home, 'B');
      // Another session on A, idle, holding a copy of the same login.
      const live = path.join(home, 'live-session');
      mkdirSync(live, { recursive: true });
      signIn(live, 'A');
      writeFileSync(path.join(live, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } }));
      takeLease('A', live, context.ctx);
      server.signOut('A');
      setActive('A', context.ctx);

      expect(await runCommand(context, [])).toBe(0);

      expect(launchesIn(runsLog).map((l) => l.marker)).toEqual(['B']);
      const said = eventsIn(context)
        .filter((e) => e.kind === 'credential-sync' && e.data?.direction === 'recover')
        .map((e) => e.msg);
      expect(said).toEqual([
        expect.stringMatching(/^the stored "A" login was dead, and so was the copy its live session \(pid \d+\) holds/),
      ]);
    },
  );
});
