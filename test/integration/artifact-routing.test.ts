import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

/** When on, Claude cannot be made to read its login again (the login file's time could not be changed). */
const nudge = vi.hoisted(() => ({ fails: false }));
vi.mock('../../src/accounts/credential-vault.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/accounts/credential-vault.js')>();
  return {
    ...real,
    nudgeLoginReread: (...args: Parameters<typeof real.nudgeLoginReread>): boolean =>
      nudge.fails ? false : real.nudgeLoginReread(...args),
  };
});
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodePty } from '../../src/util/native-pty.js';
import { addCommand } from '../../src/commands/add.js';
import { updateAccount } from '../../src/accounts/registry.js';
import { runCommand } from '../../src/commands/run.js';
import { getActive, setActive } from '../../src/state/active.js';
import { writeSwitchRequest } from '../../src/state/switch-request.js';
import { loadConfig, saveConfig } from '../../src/config/config.js';
import { cappedNames, loadLedger } from '../../src/ledger/ledger.js';
import { readEvents } from '../../src/events/log.js';
import { readPages, recordPath } from '../../src/artifacts/record.js';
import { saveToken } from '../../src/daemon/token-store.js';
import type { PartialConfig } from '../../src/config/config.schema.js';
import type { CliContext } from '../../src/context.js';

/**
 * Page routing, end to end: a real session in a pseudo-terminal, the fake
 * claude calling the Artifact tool the way the real one does (the hooks in the
 * session's settings, run as programs), and ccx's own hook entry answering.
 * What is checked is which account's login was in the session's folder when
 * the call went out, and that the session, the active account and the ledger
 * are as they were afterwards.
 */

const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));
const hookEntry = fileURLToPath(new URL('../../src/artifacts/hook-entry.ts', import.meta.url));
const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
const PAGE = path.resolve('pages', 'shape-lab.html');
const URL_OF_PAGE = 'https://claude.ai/artifact/BmhXcGdEGscNbm7Pk1YSPc';
const RESPONSE = { url: URL_OF_PAGE, artifact_id: '573916ad-1115-45ad-965e-2c91f5276edb', title: 'Shape Lab' };

interface Entry {
  type: string;
  id?: string;
  marker?: string | null;
  /** At a call: whether the login file's time had changed since Claude started. */
  loginReread?: boolean;
  reason?: string;
  context?: string;
}

type Verdict = 'limited' | 'allowed' | 'unknown';

function makeContext(home: string, verifyCap: () => Promise<Verdict>, holdMs?: number): CliContext {
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  return {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    verifyCap,
    ...(holdMs !== undefined ? { artifactHop: { holdMs } } : {}),
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
  };
}

async function loginAccount(context: CliContext, home: string, name: string, signedIn = true): Promise<void> {
  const dir = path.join(home, 'profiles', name);
  await addCommand(context, name, { dir, login: false });
  mkdirSync(dir, { recursive: true });
  if (signedIn) writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }), 'utf8');
}

/** The hooks as `ccx config artifacts.*` installs them, run from source so no build is needed. */
function installHooks(home: string): void {
  const hook = (event: string) => ({
    matcher: 'Artifact',
    hooks: [{ type: 'command', command: process.execPath, args: [tsx, hookEntry, event], timeout: 45 }],
  });
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [hook('pre')],
        PostToolUse: [hook('post')],
        PostToolUseFailure: [hook('fail')],
        // No matcher: Claude runs these after every batch of tool calls.
        PostToolBatch: [{ hooks: [{ type: 'command', command: process.execPath, args: [tsx, hookEntry, 'batch'], timeout: 30 }] }],
      },
    }),
    'utf8',
  );
}

function entries(runsLog: string): Entry[] {
  if (!existsSync(runsLog)) return [];
  return readFileSync(runsLog, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Entry);
}

const { spawn } = nodePty();
let ptyProblem = '';
function canSpawnPty(): boolean {
  try {
    const probe = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });
    try {
      probe.kill();
    } catch {
      /* already gone */
    }
    return true;
  } catch (err) {
    ptyProblem = (err as Error).message;
    return false;
  }
}
const PTY_AVAILABLE = canSpawnPty();
if (!PTY_AVAILABLE && !process.env.CI) {
  console.warn(`[skipped] page routing tests: no pseudo-terminal here (${ptyProblem}).`);
}

const TEST_ENV = [
  'FAKE_CLAUDE_IDLE_MS',
  'FAKE_CLAUDE_SET_STATE',
  'FAKE_CLAUDE_EMIT_CAP',
  'FAKE_CLAUDE_CAP_EVERY_MS',
  'FAKE_CLAUDE_CAP_AFTER_MS',
  'FAKE_CLAUDE_RUNS_LOG',
  'FAKE_CLAUDE_ARTIFACT',
  'FAKE_CLAUDE_ARTIFACT_THEN_EXIT_MS',
  'FAKE_CLAUDE_SESSION_RECORD',
  'FAKE_CLAUDE_TRANSCRIPT',
  'FAKE_CLAUDE_RESUMED_IDLE_MS',
  // The hook is a program Claude starts, so it finds the test's ccx home the
  // way a real one finds the real one: in its environment.
  'CLAUDE_AUTO_SWITCH_HOME',
];

interface Scene {
  home: string;
  runsLog: string;
  context: CliContext;
}

/** Accounts A and B signed in, the session starting on A, and one run of it making `calls`. */
async function scene(
  options: {
    artifacts?: PartialConfig['artifacts'];
    hooks?: boolean;
    calls: Array<Record<string, unknown>>;
    verifyCap?: () => Promise<Verdict>;
    holdMs?: number;
    thenExitMs?: number;
    record?: boolean;
    extraAccounts?: Array<{ name: string; signedIn: boolean }>;
    /** Limit words on the screen: once at the start, then again and again. */
    capWords?: boolean;
    /** An account with a long-lived token of its own (ccx token). */
    tokenFor?: string;
    /** The address Claude records the session as signed in as, once it is up. A is a@example.com, B b@example.com. */
    signedInAs?: string;
    /** The session's login is in the Keychain (macOS, once Claude has saved it there itself). */
    loginInKeychain?: boolean;
    /** How long a relaunched Claude stays; the first one's length is set above. */
    resumedIdleMs?: number;
  },
): Promise<Scene> {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-artifact-routing-'));
  const runsLog = path.join(home, 'runs.jsonl');
  Object.assign(process.env, {
    CLAUDE_AUTO_SWITCH_HOME: home,
    FAKE_CLAUDE_RUNS_LOG: runsLog,
    // The longest the run may take; it ends itself soon after its last call.
    FAKE_CLAUDE_IDLE_MS: '50000',
    FAKE_CLAUDE_ARTIFACT: JSON.stringify(options.calls),
    FAKE_CLAUDE_ARTIFACT_THEN_EXIT_MS: String(options.thenExitMs ?? 300),
    ...(options.record ? { FAKE_CLAUDE_SESSION_RECORD: '1', FAKE_CLAUDE_TRANSCRIPT: '1' } : {}),
    ...(options.capWords
      ? { FAKE_CLAUDE_EMIT_CAP: '1', FAKE_CLAUDE_CAP_AFTER_MS: '700', FAKE_CLAUDE_CAP_EVERY_MS: '300' }
      : {}),
    ...(options.resumedIdleMs !== undefined ? { FAKE_CLAUDE_RESUMED_IDLE_MS: String(options.resumedIdleMs) } : {}),
  });
  const context = makeContext(home, options.verifyCap ?? (() => Promise.resolve('allowed')), options.holdMs);
  if (options.loginInKeychain) context.loginInKeychain = () => true;
  if (options.artifacts) {
    saveConfig({ artifacts: options.artifacts }, context.ctx);
    context.config = loadConfig(context.ctx);
  }
  if (options.hooks !== false) installHooks(home);
  await loginAccount(context, home, 'A');
  await loginAccount(context, home, 'B');
  for (const extra of options.extraAccounts ?? []) await loginAccount(context, home, extra.name, extra.signedIn);
  if (options.tokenFor) saveToken(path.join(home, 'profiles', options.tokenFor), 'a-long-lived-token');
  if (options.signedInAs) {
    for (const name of ['A', 'B']) updateAccount(name, { email: `${name.toLowerCase()}@example.com` }, context.ctx);
    process.env.FAKE_CLAUDE_SET_STATE = JSON.stringify({ oauthAccount: { emailAddress: options.signedInAs } });
  }
  setActive('A', context.ctx);
  return { home, runsLog, context };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for something to be true rather than for a guessed length of time. */
async function waitFor<T>(what: string, read: () => T, ok: (value: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = read();
  while (Date.now() < deadline) {
    last = read();
    if (ok(last)) return last;
    await sleep(50);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}; last saw ${JSON.stringify(last)}`);
}

const of = (log: Entry[], type: string, id?: string): Entry[] =>
  log.filter((entry) => entry.type === type && (id === undefined || entry.id === id));

/** Nothing a visit to another account may leave behind. */
function expectNothingLeftBehind(s: Scene): void {
  expect(getActive(s.context.ctx)).toBe('A');
  expect([...cappedNames(loadLedger(s.context.ctx), Date.now())]).toEqual([]);
  const events = readEvents(s.home, 200);
  expect(events.filter((e) => e.kind === 'capped' || e.kind === 'cap-relief')).toEqual([]);
  expect(events.filter((e) => /switching to|hit its limit/.test(e.msg))).toEqual([]);
  expect(existsSync(path.join(s.home, 'switch-request.json'))).toBe(false);
  const perSession = path.join(s.home, 'switch-requests');
  expect(existsSync(perSession) ? readdirSync(perSession) : []).toEqual([]);
}

describe.skipIf(!PTY_AVAILABLE && !process.env.CI)('page routing in a running session (against fake-claude)', () => {
  afterEach(() => {
    for (const name of TEST_ENV) delete process.env[name];
    nudge.fails = false;
  });

  it(
    'publishes a new page as the home account and is straight back on its own, with nothing else moved',
    { timeout: 120_000 },
    async () => {
      const s = await scene({
        artifacts: { home: 'B' },
        calls: [{ afterMs: 1500, id: 'toolu_new', input: { file_path: PAGE }, response: RESPONSE }],
      });
      expect(await runCommand(s.context, [])).toBe(0);
      const log = entries(s.runsLog);
      // One launch: the session was moved under the running Claude, never restarted.
      expect(of(log, 'launch').map((e) => e.marker)).toEqual(['A']);
      expect(of(log, 'artifact-denied')).toEqual([]);
      expect(of(log, 'artifact-call', 'toolu_new').map((e) => e.marker)).toEqual(['B']);
      expect(of(log, 'artifact-over', 'toolu_new').map((e) => e.marker)).toEqual(['A']);
      expect(of(log, 'reread').map((e) => e.marker)).toEqual(['A']);
      expect(readPages(s.context.ctx)).toMatchObject([{ url: URL_OF_PAGE, owner: 'B', file: PAGE, title: 'Shape Lab' }]);
      expectNothingLeftBehind(s);
      const hops = readEvents(s.home, 200).filter((e) => e.kind === 'artifact-hop');
      expect(hops).toHaveLength(1);
      expect(hops[0]?.data).toMatchObject({ to: 'B', from: 'A', endedBy: 'done' });
    },
  );

  it(
    'tells Claude to use its login even when the page belongs on the account the session is on',
    { timeout: 120_000 },
    async () => {
      // Claude can still be on the login before an ordinary move for up to half
      // a minute, so a call that needs no move still has it read the login again.
      const s = await scene({
        artifacts: { home: 'A' },
        calls: [{ afterMs: 1500, id: 'toolu_new', input: { file_path: PAGE }, response: RESPONSE }],
      });
      expect(await runCommand(s.context, [])).toBe(0);
      const log = entries(s.runsLog);
      expect(of(log, 'artifact-call').map((e) => [e.marker, e.loginReread])).toEqual([['A', true]]);
      expect(of(log, 'launch')).toHaveLength(1);
      expect(readPages(s.context.ctx)[0]?.owner).toBe('A');
      expectNothingLeftBehind(s);
    },
  );

  it(
    'makes a login file appear for Claude to read its Keychain login again, and never saves that file anywhere',
    { timeout: 120_000 },
    async () => {
      // Claude has saved the session's login to the Keychain, and its file is gone:
      // no time on it can change, so only a file appearing makes Claude read again.
      const s = await scene({
        artifacts: { home: 'A' },
        loginInKeychain: true,
        calls: [{ afterMs: 1500, id: 'toolu_new', input: { file_path: PAGE }, response: RESPONSE, loginToKeychain: true }],
      });
      const profileA = path.join(s.home, 'profiles', 'A', '.credentials.json');
      const loginA = readFileSync(profileA, 'utf8');
      expect(await runCommand(s.context, [])).toBe(0);
      const log = entries(s.runsLog);
      expect(of(log, 'artifact-call').map((e) => e.loginReread)).toEqual([true]);
      expect(readPages(s.context.ctx)[0]?.owner).toBe('A');
      // The file held no login, and was never saved over the profile's.
      expect(readFileSync(profileA, 'utf8')).toBe(loginA);
      expectNothingLeftBehind(s);
    },
  );

  it(
    'holds a call already on its account through that account running out, and only then acts on it',
    { timeout: 120_000 },
    async () => {
      // A's own limit is met while the call is out: relief may move the session,
      // but not under the call.
      const s = await scene({
        artifacts: { home: 'A' },
        record: true,
        verifyCap: () => Promise.resolve('limited'),
        // Time for the limit to be acted on after the call, on a slow machine too.
        thenExitMs: 6000,
        resumedIdleMs: 1500,
        calls: [{ afterMs: 1500, id: 'toolu_new', input: { file_path: PAGE }, response: RESPONSE, refuseDuring: true, takesMs: 4000 }],
      });
      await runCommand(s.context, []);
      const log = entries(s.runsLog);
      expect(of(log, 'artifact-call').map((e) => e.marker)).toEqual(['A']);
      expect(of(log, 'artifact-end').map((e) => e.marker)).toEqual(['A']);
      expect(readPages(s.context.ctx)[0]?.owner).toBe('A');
      // The limit was acted on once the call was over.
      const moved = readEvents(s.home, 200).filter((e) => e.kind === 'capped' || e.kind === 'cap-relief');
      expect(moved.length).toBeGreaterThan(0);
    },
  );

  it(
    'keeps the session on the account for two calls there at once, until the later one is over',
    { timeout: 120_000 },
    async () => {
      // A background subagent's call and the main thread's, overlapping.
      const s = await scene({
        artifacts: { home: 'B' },
        thenExitMs: 1500,
        calls: [
          { afterMs: 1500, id: 'toolu_first', input: { file_path: PAGE }, response: RESPONSE, takesMs: 2500 },
          {
            afterMs: 2500,
            id: 'toolu_second',
            input: { file_path: path.resolve('pages', 'second.html') },
            response: {
              url: 'https://claude.ai/artifact/second',
              artifact_id: '6a1e0c2b-0000-4000-8000-000000000002',
              title: 'Second',
            },
            takesMs: 3000,
          },
        ],
      });
      expect(await runCommand(s.context, [])).toBe(0);
      const log = entries(s.runsLog);
      expect(of(log, 'launch')).toHaveLength(1);
      expect(of(log, 'artifact-call').map((e) => [e.id, e.marker])).toEqual([
        ['toolu_first', 'B'],
        ['toolu_second', 'B'],
      ]);
      // On B to the very end of each, though the first ended while the second was out.
      expect(of(log, 'artifact-end').map((e) => [e.id, e.marker])).toEqual([
        ['toolu_first', 'B'],
        ['toolu_second', 'B'],
      ]);
      expect(of(log, 'reread').map((e) => e.marker)).toEqual(['A']);
      expect(readPages(s.context.ctx).map((p) => p.owner)).toEqual(['B', 'B']);
      expectNothingLeftBehind(s);
    },
  );

  it(
    'is back before the next model request when the person’s own hook refuses the call after ccx moved',
    { timeout: 120_000 },
    async () => {
      const s = await scene({
        artifacts: { home: 'B' },
        holdMs: 60_000,
        calls: [{ afterMs: 1500, id: 'toolu_new', input: { file_path: PAGE }, deniedByOtherHook: true }],
      });
      expect(await runCommand(s.context, [])).toBe(0);
      const log = entries(s.runsLog);
      // It was moved for the call, the call never ran, and no after-hook came.
      expect(of(log, 'artifact-denied-by-other').map((e) => e.marker)).toEqual(['B']);
      expect(of(log, 'artifact-call')).toEqual([]);
      // Claude's next request goes out at once, on the session's own account.
      expect(of(log, 'model-request').map((e) => e.marker)).toEqual(['A']);
      expect(existsSync(recordPath(s.context.ctx))).toBe(false);
      expectNothingLeftBehind(s);
    },
  );

  it(
    'sends the same conversation publishing that file again to the account the page is on',
    { timeout: 120_000 },
    async () => {
      const s = await scene({
        artifacts: { home: 'B' },
        calls: [
          { afterMs: 1500, id: 'toolu_new', input: { file_path: PAGE }, response: RESPONSE },
          { afterMs: 9000, id: 'toolu_again', input: { file_path: PAGE }, response: { ...RESPONSE, updated: true } },
        ],
      });
      expect(await runCommand(s.context, [])).toBe(0);
      const log = entries(s.runsLog);
      expect(of(log, 'launch')).toHaveLength(1);
      expect(of(log, 'artifact-call').map((e) => [e.id, e.marker])).toEqual([
        ['toolu_new', 'B'],
        ['toolu_again', 'B'],
      ]);
      expect(of(log, 'artifact-over').map((e) => e.marker)).toEqual(['A', 'A']);
      const pages = readPages(s.context.ctx);
      expect(pages).toHaveLength(1);
      expect(pages[0]?.owner).toBe('B');
      expectNothingLeftBehind(s);
    },
  );

  it(
    'is back on its own account by its own clock when the after-hook never arrives',
    { timeout: 120_000 },
    async () => {
      const s = await scene({
        artifacts: { home: 'B' },
        holdMs: 1500,
        thenExitMs: 3500,
        calls: [{ afterMs: 1500, id: 'toolu_lost', input: { file_path: PAGE }, skipAfterHook: true }],
      });
      expect(await runCommand(s.context, [])).toBe(0);
      const log = entries(s.runsLog);
      expect(of(log, 'launch')).toHaveLength(1);
      expect(of(log, 'artifact-call').map((e) => e.marker)).toEqual(['B']);
      // Nothing reported the call over, so it was still away when the call ended...
      expect(of(log, 'artifact-over').map((e) => e.marker)).toEqual(['B']);
      // ...and back a moment later with nothing having asked.
      expect(of(log, 'reread').map((e) => e.marker)).toEqual(['A']);
      const hops = readEvents(s.home, 200).filter((e) => e.kind === 'artifact-hop');
      expect(hops.map((e) => e.data?.endedBy)).toEqual(['deadline']);
      expectNothingLeftBehind(s);
    },
  );

  it(
    'is back as soon as the call’s result is in the conversation’s record, hook or no hook',
    { timeout: 120_000 },
    async () => {
      const s = await scene({
        artifacts: { home: 'B' },
        holdMs: 60_000,
        thenExitMs: 2500,
        calls: [{ afterMs: 1500, id: 'toolu_lost', input: { file_path: PAGE }, skipAfterHook: true, writeResult: true }],
      });
      expect(await runCommand(s.context, [])).toBe(0);
      expect(of(entries(s.runsLog), 'reread').map((e) => e.marker)).toEqual(['A']);
      const hops = readEvents(s.home, 200).filter((e) => e.kind === 'artifact-hop');
      expect(hops.map((e) => e.data?.endedBy)).toEqual(['result']);
    },
  );

  it(
    'is put back after a call that failed, and records nothing for it',
    { timeout: 120_000 },
    async () => {
      const s = await scene({
        artifacts: { home: 'B' },
        calls: [{ afterMs: 1500, id: 'toolu_bad', input: { file_path: PAGE }, fail: true }],
      });
      expect(await runCommand(s.context, [])).toBe(0);
      const log = entries(s.runsLog);
      expect(of(log, 'artifact-call').map((e) => e.marker)).toEqual(['B']);
      expect(of(log, 'artifact-over').map((e) => e.marker)).toEqual(['A']);
      expect(existsSync(recordPath(s.context.ctx))).toBe(false);
      expectNothingLeftBehind(s);
    },
  );

  it(
    'caps nothing and moves nothing when a turn is refused while it is on the other account',
    { timeout: 120_000 },
    async () => {
      let probes = 0;
      const s = await scene({
        artifacts: { home: 'B' },
        record: true,
        // Whoever is asked says "out": were the refusal acted on, A would be
        // capped and the session relaunched on B.
        verifyCap: () => {
          probes += 1;
          return Promise.resolve('limited');
        },
        thenExitMs: 3000,
        calls: [{ afterMs: 2500, id: 'toolu_new', input: { file_path: PAGE }, response: RESPONSE, refuseDuring: true, takesMs: 600 }],
      });
      expect(await runCommand(s.context, [])).toBe(0);
      const log = entries(s.runsLog);
      expect(of(log, 'artifact-call').map((e) => e.marker)).toEqual(['B']);
      expect(of(log, 'launch').map((e) => e.marker)).toEqual(['A']);
      expect(of(log, 'reread').map((e) => e.marker)).toEqual(['A']);
      expect(probes).toBe(0);
      expectNothingLeftBehind(s);
    },
  );

  it(
    'does not read limit words that reach the screen while it is on the other account',
    { timeout: 120_000 },
    async () => {
      let probes = 0;
      const s = await scene({
        artifacts: { home: 'B' },
        // No record to read here, so the screen is what stands in for it.
        verifyCap: () => {
          probes += 1;
          return Promise.resolve('limited');
        },
        thenExitMs: 2500,
        calls: [
          {
            afterMs: 1500,
            id: 'toolu_new',
            input: { file_path: PAGE },
            response: RESPONSE,
            takesMs: 1500,
            sayDuring: 'You have reached your Fable 5 limit. Run /usage-credits to continue.',
          },
        ],
      });
      expect(await runCommand(s.context, [])).toBe(0);
      const log = entries(s.runsLog);
      expect(of(log, 'artifact-call').map((e) => e.marker)).toEqual(['B']);
      expect(of(log, 'launch')).toHaveLength(1);
      expect(of(log, 'reread').map((e) => e.marker)).toEqual(['A']);
      expect(probes).toBe(0);
      expectNothingLeftBehind(s);
    },
  );

  it(
    'refuses a call, moved or not, when Claude cannot be made to read the login it is to go out on',
    { timeout: 120_000 },
    async () => {
      nudge.fails = true;
      const moved = await scene({
        artifacts: { home: 'B' },
        calls: [{ afterMs: 1500, id: 'toolu_new', input: { file_path: PAGE }, response: RESPONSE }],
      });
      expect(await runCommand(moved.context, [])).toBe(0);
      let log = entries(moved.runsLog);
      expect(of(log, 'artifact-call')).toEqual([]);
      expect(of(log, 'artifact-denied').map((e) => [e.reason, e.marker])).toEqual([
        [expect.stringContaining('could not put this session on "B"'), 'A'],
      ]);
      expect(existsSync(recordPath(moved.context.ctx))).toBe(false);
      expectNothingLeftBehind(moved);

      for (const name of TEST_ENV) delete process.env[name];
      const stayed = await scene({
        artifacts: { home: 'A' },
        calls: [{ afterMs: 1500, id: 'toolu_new', input: { file_path: PAGE }, response: RESPONSE }],
      });
      expect(await runCommand(stayed.context, [])).toBe(0);
      log = entries(stayed.runsLog);
      expect(of(log, 'artifact-call')).toEqual([]);
      expect(of(log, 'artifact-denied')[0]?.reason).toContain('could not make Claude use the "A" login');
      expectNothingLeftBehind(stayed);
    },
  );

  it(
    'refuses the call when the home account is not signed in, and publishes nothing anywhere',
    { timeout: 120_000 },
    async () => {
      const s = await scene({
        artifacts: { home: 'C' },
        extraAccounts: [{ name: 'C', signedIn: false }],
        calls: [{ afterMs: 1500, id: 'toolu_new', input: { file_path: PAGE }, response: RESPONSE }],
      });
      expect(await runCommand(s.context, [])).toBe(0);
      const log = entries(s.runsLog);
      expect(of(log, 'artifact-call')).toEqual([]);
      const denied = of(log, 'artifact-denied');
      expect(denied).toHaveLength(1);
      expect(denied[0]?.reason).toContain('ccx login C');
      expect(denied[0]?.marker).toBe('A');
      expect(existsSync(recordPath(s.context.ctx))).toBe(false);
      expectNothingLeftBehind(s);
    },
  );

  it(
    'makes a move asked for while it is away only once it is back, instead of taking the visit for the move',
    { timeout: 120_000 },
    async () => {
      const s = await scene({
        artifacts: { home: 'B' },
        thenExitMs: 3500,
        calls: [{ afterMs: 1500, id: 'toolu_new', input: { file_path: PAGE }, response: RESPONSE, takesMs: 2500 }],
      });
      const running = runCommand(s.context, []);
      // While the call is out, on B: the person asks for this session to be on B for good.
      await waitFor('the call to go out', () => of(entries(s.runsLog), 'artifact-call').length, (n) => n > 0);
      writeSwitchRequest('B', Date.now(), 'seamless', s.context.ctx, process.pid);
      expect(await running).toBe(0);
      const log = entries(s.runsLog);
      expect(of(log, 'launch')).toHaveLength(1);
      expect(of(log, 'artifact-call').map((e) => e.marker)).toEqual(['B']);
      // Answered as "already there" during the visit, the request would have
      // been dropped and the session left on A.
      expect(of(log, 'reread').map((e) => e.marker)).toEqual(['B']);
      const hops = readEvents(s.home, 200).filter((e) => e.kind === 'artifact-hop');
      expect(hops.map((e) => e.data?.endedBy)).toEqual(['done']);
      expect(readPages(s.context.ctx)[0]?.owner).toBe('B');
    },
  );

  it(
    'puts down nothing against its own account when Claude exits while it is away with an old limit still unanswered',
    { timeout: 120_000 },
    async () => {
      let probes = 0;
      const s = await scene({
        artifacts: { home: 'B' },
        holdMs: 60_000,
        thenExitMs: 400,
        // The first question (the limit words printed at the start) is answered
        // "not limited"; anyone asked after that says "limited".
        verifyCap: () => {
          probes += 1;
          return Promise.resolve(probes === 1 ? 'allowed' : 'limited');
        },
        calls: [{ afterMs: 3000, id: 'toolu_new', input: { file_path: PAGE }, skipAfterHook: true }],
        capWords: true,
      });
      expect(await runCommand(s.context, [])).toBe(0);
      const log = entries(s.runsLog);
      expect(of(log, 'artifact-call').map((e) => e.marker)).toEqual(['B']);
      // Still away when it exited: nothing reported the call over.
      expect(of(log, 'reread').map((e) => e.marker)).toEqual(['B']);
      // Asked once, before the visit, and not again while the login in the
      // folder was B's: a "limited" then would have been written against A.
      expect(probes).toBe(1);
      expect(of(log, 'launch')).toHaveLength(1);
      const hops = readEvents(s.home, 200).filter((e) => e.kind === 'artifact-hop');
      expect(hops.map((e) => e.data?.endedBy)).toEqual(['child-exit']);
      expectNothingLeftBehind(s);
    },
  );

  it(
    'refuses the call in a session that signs in with a long-lived token, which no move in place can change',
    { timeout: 120_000 },
    async () => {
      const s = await scene({
        artifacts: { home: 'B' },
        tokenFor: 'A',
        calls: [{ afterMs: 1500, id: 'toolu_new', input: { file_path: PAGE }, response: RESPONSE }],
      });
      expect(await runCommand(s.context, [])).toBe(0);
      const log = entries(s.runsLog);
      expect(of(log, 'artifact-call')).toEqual([]);
      expect(of(log, 'artifact-denied')[0]?.reason).toContain('long-lived token');
      expect(of(log, 'reread').map((e) => e.marker)).toEqual(['A']);
      expectNothingLeftBehind(s);
    },
  );

  it(
    'refuses the call in a session signed in as another account from inside, whose login a move would lose',
    { timeout: 120_000 },
    async () => {
      const s = await scene({
        artifacts: { home: 'A' },
        // What a /login inside the session leaves in its folder: B's identity, in a session ccx started on A.
        signedInAs: 'b@example.com',
        calls: [{ afterMs: 1500, id: 'toolu_new', input: { file_path: PAGE }, response: RESPONSE }],
      });
      expect(await runCommand(s.context, [])).toBe(0);
      const log = entries(s.runsLog);
      expect(of(log, 'artifact-call')).toEqual([]);
      expect(of(log, 'artifact-denied')[0]?.reason).toContain('signed in as a different account from inside');
      expect(of(log, 'launch')).toHaveLength(1);
      expectNothingLeftBehind(s);
    },
  );

  it(
    'does nothing at all with both settings off, hooks or no hooks',
    { timeout: 120_000 },
    async () => {
      for (const hooks of [false, true]) {
        const s = await scene({
          hooks,
          calls: [
            { afterMs: 1500, id: 'toolu_new', input: { file_path: PAGE }, response: RESPONSE },
            { afterMs: 1600, id: 'toolu_url', input: { file_path: PAGE, url: URL_OF_PAGE }, response: RESPONSE },
          ],
        });
        expect(await runCommand(s.context, [])).toBe(0);
        const log = entries(s.runsLog);
        expect(of(log, 'artifact-call').map((e) => e.marker)).toEqual(['A', 'A']);
        expect(of(log, 'artifact-over').map((e) => e.marker)).toEqual(['A', 'A']);
        expect(of(log, 'artifact-denied')).toEqual([]);
        expect(of(log, 'artifact-context')).toEqual([]);
        expect(existsSync(recordPath(s.context.ctx))).toBe(false);
        expect(readEvents(s.home, 200).filter((e) => e.kind === 'artifact-hop')).toEqual([]);
        expectNothingLeftBehind(s);
        for (const name of TEST_ENV) delete process.env[name];
      }
    },
  );
});
