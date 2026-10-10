import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodePty } from '../../src/util/native-pty.js';
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
  type: 'launch' | 'reread' | 'prompt' | 'status' | 'subagent-refusal' | 'subagent-done';
  args?: string[];
  marker?: string | null;
  text?: string;
  refused?: boolean;
  status?: string;
  pid?: number;
  oauthToken?: string | null;
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

// Through the loader every part of ccx uses, so these tests open terminals
// exactly as ccx does, including what it does to make that possible.
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
export const PTY_AVAILABLE = canSpawnPty();
// Skipped only on a developer machine without a terminal. In CI a terminal
// that cannot open is a failure: skipping is how an install that could not
// start `claude` at all on macOS still passed.
if (!PTY_AVAILABLE && !process.env.CI) {
  console.warn(`[skipped] carry-on tests: no pseudo-terminal here (${ptyProblem}).`);
}

export const FAKE_ENV = [
  'FAKE_CLAUDE_IDLE_MS',
  'FAKE_CLAUDE_RESUMED_IDLE_MS',
  'FAKE_CLAUDE_RUNS_LOG',
  'FAKE_CLAUDE_SESSION_RECORD',
  'FAKE_CLAUDE_TRANSCRIPT',
  'FAKE_CLAUDE_REFUSE_AFTER_MS',
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
  'FAKE_CLAUDE_GRANDCHILD',
];

/** The fake as a Claude that can be typed into, on an account that refuses on A. */
export const TYPEABLE = {
  FAKE_CLAUDE_SESSION_RECORD: '1',
  FAKE_CLAUDE_TRANSCRIPT: '1',
  FAKE_CLAUDE_READS_INPUT: '1',
  FAKE_CLAUDE_STATUS: 'idle',
  FAKE_CLAUDE_REFUSE_ON: 'A',
};

/** Seconds in a test, where production waits half a minute and more. */
export const QUICK = {
  pickupMs: 300,
  settleMs: 100,
  submitMs: 3000,
  answerMs: 300,
  blockedMs: 1500,
};

export const prompts = (log: Entry[]): Entry[] => log.filter((e) => e.type === 'prompt');
export const launches = (log: Entry[]): Entry[] => log.filter((e) => e.type === 'launch');

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
  Object.assign(process.env, { FAKE_CLAUDE_RUNS_LOG: runsLog, ...TYPEABLE, ...options.env });
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
    outcome,
  };
}
