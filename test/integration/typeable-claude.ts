import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { probeTerminal } from './terminal-probe.js';
import {
  runPtySession,
  type CapContext,
  type CapDecision,
  type CarryOnEvent,
} from '../../src/launcher/pty-session.js';
import type { TerminalInput } from '../../src/launcher/terminal-input.js';
import type { SessionOutcome } from '../../src/launcher/hot-swap.js';

/**
 * What the tests of a session moved under a live Claude share: the fake claude
 * as one that can be typed into, and one such Claude in a pseudo-terminal.
 * Not a test file itself.
 */

export const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
export const PROMPT = 'Moved by ccx: carry on where you stopped.';

export interface Entry {
  type:
    | 'launch'
    | 'reread'
    | 'prompt'
    | 'status'
    | 'subagent-refusal'
    | 'subagent-done'
    | 'menu'
    | 'menu-key'
    | 'cap-words';
  args?: string[];
  marker?: string | null;
  text?: string;
  refused?: boolean;
  status?: string;
  pid?: number;
  oauthToken?: string | null;
  /** For a `menu` entry: whether Claude's usage-limit menu opened or closed. */
  open?: boolean;
}

export function readLog(runsLog: string): Entry[] {
  if (!existsSync(runsLog)) return [];
  return readFileSync(runsLog, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Entry);
}

export async function waitFor<T>(
  what: string,
  read: () => T,
  ok: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = read();
  while (Date.now() < deadline) {
    last = read();
    if (ok(last)) return last;
    await sleep(50);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${what}; last saw ${JSON.stringify(last)}`,
  );
}

const terminal = probeTerminal();
export const PTY_AVAILABLE = terminal.open;
// Skipped only on a developer machine without a terminal. In CI a terminal
// that cannot open is a failure: skipping is how an install that could not
// start `claude` at all on macOS still passed.
if (!PTY_AVAILABLE && !process.env.CI) {
  console.warn(`[skipped] carry-on tests: no pseudo-terminal here (${terminal.problem}).`);
}

export const FAKE_ENV = [
  'FAKE_CLAUDE_IDLE_MS',
  'FAKE_CLAUDE_RESUMED_IDLE_MS',
  'FAKE_CLAUDE_RUNS_LOG',
  'FAKE_CLAUDE_SESSION_RECORD',
  'FAKE_CLAUDE_TRANSCRIPT',
  'FAKE_CLAUDE_REFUSE_AFTER_MS',
  'FAKE_CLAUDE_REFUSE_WHEN',
  'FAKE_CLAUDE_REFUSE_ON',
  'FAKE_CLAUDE_SUBAGENT_REFUSE_AFTER_MS',
  'FAKE_CLAUDE_SUBAGENT_REFUSE_AGAIN_AFTER_MS',
  'FAKE_CLAUDE_SUBAGENT_WRITES_UNTIL_MS',
  'FAKE_CLAUDE_IDLE_STATUS',
  'FAKE_CLAUDE_STATUS',
  'FAKE_CLAUDE_STATUS_THEN',
  'FAKE_CLAUDE_READS_INPUT',
  'FAKE_CLAUDE_OLD_LOGIN_REQUESTS',
  'FAKE_CLAUDE_EXIT_AFTER_PROMPTS',
  'FAKE_CLAUDE_EXIT_DELAY_MS',
  'FAKE_CLAUDE_EXIT_WHEN',
  'FAKE_CLAUDE_GRANDCHILD',
  'FAKE_CLAUDE_LIMIT_MENU',
];

/** The fake as a Claude that can be typed into, on an account that refuses on A. */
export const TYPEABLE = {
  FAKE_CLAUDE_SESSION_RECORD: '1',
  FAKE_CLAUDE_TRANSCRIPT: '1',
  FAKE_CLAUDE_READS_INPUT: '1',
  FAKE_CLAUDE_STATUS: 'idle',
  FAKE_CLAUDE_REFUSE_ON: 'A',
};

/**
 * Seconds in a test, where production waits half a minute and more. ccx reads
 * Claude's record of the conversation every 1.2 s, so a wait that ends on
 * something not having shown up there (a refusal of the typed prompt, a
 * subagent's write) stays well above that, as production's do. Shorter, it
 * could end between Claude writing the thing and ccx reading it.
 */
export const QUICK = {
  pickupMs: 300,
  settleMs: 100,
  submitMs: 3000,
  answerMs: 5000,
  blockedMs: 4000,
};

/** Whether ccx has said what became of a carry-on prompt: over, or handed over by relaunch. */
export const carryOnEnded = (events: CarryOnEvent[]): boolean =>
  events.some((e) => e.kind === 'done' || e.kind === 'relaunch');

export const prompts = (log: Entry[]): Entry[] => log.filter((e) => e.type === 'prompt');
export const launches = (log: Entry[]): Entry[] => log.filter((e) => e.type === 'launch');

/**
 * Give account `name` a login that is due for renewal: it expired a minute
 * ago. `account` stays in it, so the fake still says which account it is.
 */
export function dueLogin(dir: string, name: string): void {
  writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({
      account: name,
      claudeAiOauth: { accessToken: `old-${name}`, refreshToken: `refresh-${name}`, expiresAt: Date.now() - 60_000 },
    }),
    'utf8',
  );
}

/**
 * A usage snapshot read just now, so the session's usage refresher has
 * nothing to do and renews no idle login on its own while a test runs.
 */
export function freshUsage(home: string, names: string[]): void {
  const now = Date.now();
  const entry = { fiveHour: 0.1, sevenDay: 0.1, fiveHourReset: null, sevenDayReset: null, at: now };
  writeFileSync(
    path.join(home, 'usage-snapshot.json'),
    JSON.stringify({ accounts: Object.fromEntries(names.map((n) => [n, entry])) }),
    'utf8',
  );
}

/**
 * Anthropic's token endpoint, answering every renewal with a new login, and
 * nothing else on the network: any other request fails. Undone by
 * `vi.unstubAllGlobals()`. Says how many renewals were asked for. `delayMs`:
 * how long each renewal takes to answer.
 */
export function renewingTokenEndpoint(options: { delayMs?: number } = {}): () => number {
  let renewals = 0;
  vi.stubGlobal('fetch', (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith('/v1/oauth/token')) return Promise.reject(new Error(`no network in tests: ${url}`));
    renewals += 1;
    const answer = new Response(
      JSON.stringify({ access_token: `renewed-${renewals}`, refresh_token: `next-${renewals}`, expires_in: 28_800 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    return new Promise((resolve) => setTimeout(() => resolve(answer), options.delayMs ?? 0));
  });
  return () => renewals;
}

/** A stand-in for the person's keyboard: what `press` is given reaches Claude as typed. */
function keyboard(): { input: TerminalInput; press: (text: string) => void } {
  let target: ((text: string) => void) | null = null;
  return {
    input: {
      attach(write) {
        target = write;
        return () => {
          if (target === write) target = null;
        };
      },
      observeChildOutput() {},
      close() {},
    },
    press: (text) => target?.(text),
  };
}

/**
 * One Claude in a pseudo-terminal, on account A, which refuses. The caller
 * of runPtySession decides what a confirmed limit leads to; here it moves
 * the login to B under the live child and leaves a prompt to type.
 */
export function live(options: {
  env: Record<string, string>;
  timing?: Partial<typeof QUICK>;
  decide?: (context: CapContext, moveTo: (name: string) => void) => CapDecision;
  verify?: (asked: number) => boolean;
  /** How long the account takes to answer each check; at once when not given. */
  verifyDelayMs?: number;
  /**
   * Refuse the main thread's turn as the account is first asked about a
   * refusal, rather than at a set time. So it always comes after ccx has read
   * the refusal it asks about, however late the machine let it read that.
   */
  refuseMainWhenAsked?: boolean;
  /**
   * Answer each check by the login in the session's folder at that moment, as
   * the real check does (it asks the folder's own login), instead of `verify`.
   */
  verifyLogin?: (login: string | null) => boolean;
  /** How long a check that did not lead to a move keeps the next one away. */
  refuteBackoffMs?: number;
  /** How long Claude must be left alone before ccx may end it for anything but a limit. */
  idleBeforeRestartMs?: number;
  /** Whether a newer ccx is waiting to take the session over, asked on each look. */
  newerInstall?: (moved: boolean) => boolean;
  /** The account the session is on now, when something moved it since the limit. */
  accountNow?: () => string;
}): {
  log: () => Entry[];
  events: CarryOnEvent[];
  decisions: CapContext[];
  asked: () => number;
  press: (text: string) => void;
  /** End Claude now, as it ends by itself (FAKE_CLAUDE_IDLE_MS is then only a backstop). */
  end: () => void;
  outcome: Promise<SessionOutcome>;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-carry-on-'));
  const runsLog = path.join(dir, 'runs.jsonl');
  const moveTo = (name: string): void =>
    writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }), 'utf8');
  const loginInFolder = (): string | null => {
    try {
      return (
        (
          JSON.parse(readFileSync(path.join(dir, '.credentials.json'), 'utf8')) as {
            account?: string;
          }
        ).account ?? null
      );
    } catch {
      return null;
    }
  };
  moveTo('A');
  const refuseNow = path.join(dir, 'refuse-now');
  const endNow = path.join(dir, 'end-now');
  Object.assign(process.env, {
    FAKE_CLAUDE_RUNS_LOG: runsLog,
    FAKE_CLAUDE_EXIT_WHEN: endNow,
    ...TYPEABLE,
    ...(options.refuseMainWhenAsked ? { FAKE_CLAUDE_REFUSE_WHEN: refuseNow } : {}),
    ...options.env,
  });
  const events: CarryOnEvent[] = [];
  const decisions: CapContext[] = [];
  let asked = 0;
  const keys = keyboard();
  const outcome = runPtySession({
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    args: ['--session-id', ID],
    configDir: dir,
    input: keys.input,
    onConversation: () => {},
    verifyCap: () => {
      asked += 1;
      if (asked === 1 && options.refuseMainWhenAsked) writeFileSync(refuseNow, '', 'utf8');
      // A is out; B, where it moves, has room.
      const answer = options.verifyLogin
        ? options.verifyLogin(loginInFolder())
        : options.verify
          ? options.verify(asked)
          : asked === 1;
      if (!options.verifyDelayMs) return Promise.resolve(answer);
      return new Promise((resolve) => setTimeout(() => resolve(answer), options.verifyDelayMs));
    },
    onCapConfirmed: (_hit, context) => {
      decisions.push(context);
      if (options.decide) return options.decide(context, moveTo);
      if (!context.relieve) return { kind: 'restart' };
      moveTo('B');
      return { kind: 'relieved', account: 'B', carryOn: { prompt: PROMPT, canRelaunch: true } };
    },
    onCarryOn: (event) => events.push(event),
    carryOnTiming: { ...QUICK, ...options.timing },
    ...(options.refuteBackoffMs !== undefined ? { refuteBackoffMs: options.refuteBackoffMs } : {}),
    ...(options.idleBeforeRestartMs !== undefined
      ? { idleBeforeRestartMs: options.idleBeforeRestartMs }
      : {}),
    ...(options.accountNow ? { currentAccount: options.accountNow } : {}),
    ...(options.newerInstall
      ? { handoverWhenIdle: () => options.newerInstall?.(decisions.length > 0) ?? false }
      : {}),
  });
  return {
    log: () => readLog(runsLog),
    events,
    decisions,
    asked: () => asked,
    press: keys.press,
    end: () => writeFileSync(endNow, '', 'utf8'),
    outcome,
  };
}
