import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Command } from 'commander';
import { listAccounts } from '../accounts/registry.js';
import type { CliContext } from '../context.js';
import { handleInterruption, type SignalSource } from '../launcher/interruption.js';
import { runInteractiveHotSwap } from './session.js';

/**
 * `ccx worker`: one task, run headless on an account, for an orchestrator.
 *
 * It is a ccx session without a terminal: its own folder that shares your
 * ~/.claude (so your agents, settings and MCP servers are there), the account
 * pick, logins kept safe, and when the account runs out mid-task, the same
 * conversation resumed on the next one with a note to carry on, rather than
 * the task started over. Workers spread out: each prefers a healthy account no
 * other session is using. Nothing global moves: the account your sessions
 * start on, the editor's link and the terminal are left as they are.
 *
 * Claude's own output is the worker's standard output, so an orchestrator
 * reads it as it would `claude -p`, plus a `ccx` report of which accounts did
 * the work. ccx's own messages go to standard error.
 */

export interface WorkerOptions {
  /** Run as this agent definition (`.claude/agents/<name>.md`, project or user). */
  agent?: string;
  /** An account by name, or `best` (the default): the pick order, spread across workers. */
  account?: string;
  model?: string;
  /** json (default), stream-json or text, as `claude -p --output-format`. */
  output?: string;
  /** Claude's permission mode; a worker cannot stop to ask anyone. */
  permissionMode?: string;
  /** Work in this folder: one git worktree per coder keeps workers out of each other's files. */
  cwd?: string;
  /** Read the brief from this file, or `-` for standard input. */
  briefFile?: string;
  /** End the worker, Claude and everything Claude started after this many minutes. */
  timeout?: string;
}

/** What a worker's conversation is told when it resumes on another account. */
export const WORKER_CARRY_ON =
  'Your previous turn was cut off when its account ran out of usage, and this conversation now continues on ' +
  'another account. Carry on exactly where you stopped and finish the task. If it was already finished, give ' +
  'your final answer again in full.';

const OUTPUTS = ['json', 'stream-json', 'text'] as const;
/** The longest delay a Node timer takes (2^31 - 1 ms, about 24.8 days). */
const MAX_TIMER_MS = 2_147_483_647;
type Output = (typeof OUTPUTS)[number];

/**
 * Claude flags a worker sets itself. Given again after `--`, Claude takes the
 * later one: a second --output-format turns the answer into something the
 * worker cannot read, and a conversation flag points a move at the wrong
 * conversation. Each has a worker option or no meaning for a worker.
 */
const WORKER_OWNED_FLAGS = new Set([
  '-p',
  '--print',
  '--output-format',
  '--input-format',
  '--session-id',
  '-r',
  '--resume',
  '-c',
  '--continue',
  '--fork-session',
]);

/** Which accounts a worker ran on, in order, for its report. */
export interface WorkerReport {
  accounts: string[];
  /** How many times it moved to another account. */
  moves: number;
  /** The conversation the work is in; null when none was started. */
  sessionId: string | null;
  /** Why Claude gave no answer, when it gave none. */
  error?: string;
}

/** Claude's result object in a json run's output, or null when it gave none. */
export function resultObject(stdout: string): Record<string, unknown> | null {
  const whole = stdout.trim();
  // The whole output, else its last line: Claude's result is one line, and
  // anything printed before it is not the answer.
  const lastLine =
    whole
      .split('\n')
      .filter((line) => line.trim() !== '')
      .pop() ?? '';
  for (const text of [whole, lastLine]) {
    if (text === '') continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* not one object */
    }
  }
  return null;
}

/**
 * What a worker writes once the work is over. json is always one object:
 * Claude's result with the report added, or, when Claude gave none, ccx's own
 * in the same shape saying why, so a program can always parse it. stream-json
 * gets the report as its last line (Claude's lines went out as they came).
 * text gets the report on standard error.
 */
export function workerOutput(
  output: Output,
  finalStdout: string,
  report: WorkerReport,
): { stdout: string; stderr: string } {
  const summary = `${reportLine(report)}\n${report.error !== undefined && report.accounts.length > 0 ? `[ccx] ${report.error}\n` : ''}`;
  if (output === 'stream-json')
    return { stdout: `${JSON.stringify({ type: 'ccx', ...report })}\n`, stderr: '' };
  if (output === 'json') {
    const result = report.error === undefined ? resultObject(finalStdout) : null;
    if (result) return { stdout: `${JSON.stringify({ ...result, ccx: report })}\n`, stderr: '' };
    return {
      stdout: `${JSON.stringify({
        type: 'result',
        subtype: 'error_ccx',
        is_error: true,
        result: report.error ?? 'Claude gave no result',
        session_id: report.sessionId,
        ccx: report,
      })}\n`,
      stderr: '',
    };
  }
  return { stdout: finalStdout, stderr: summary };
}

/** "[ccx] worker ran on a, then b (session ...)". */
export function reportLine(report: WorkerReport): string {
  if (report.accounts.length === 0)
    return `[ccx] worker did not run${report.error ? `: ${report.error}` : ''}`;
  const session = report.sessionId ? ` (session ${report.sessionId})` : '';
  return `[ccx] worker ran on ${report.accounts.join(', then ')}${session}`;
}

/** Where a worker writes: the process's own streams, or a test's. */
export interface WorkerIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Where the signals that end the worker come from; the process unless a test gives its own. */
  signals?: SignalSource;
}

const processIo: WorkerIo = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/**
 * The brief's words and Claude's own flags. Everything after `--` is Claude's,
 * and commander hands it over as the tail of the brief, so it is taken back
 * off there.
 */
export function splitPassthrough(
  argv: readonly string[],
  operands: string[],
): { words: string[]; passthrough: string[] } {
  const dash = argv.indexOf('--');
  const passthrough = dash >= 0 ? argv.slice(dash + 1) : [];
  return {
    words: operands.slice(0, Math.max(0, operands.length - passthrough.length)),
    passthrough,
  };
}

/** `ccx worker` on `program`. Here rather than in cli.ts so a test can drive the real parser. */
export function registerWorkerCommand(
  program: Command,
  argv: () => readonly string[],
  run: (words: string[], options: WorkerOptions, passthrough: string[]) => Promise<void>,
): void {
  program
    .command('worker')
    .description(
      'run one task headless on an account, for an orchestrator; when the account runs out it resumes on the next (claude flags after --)',
    )
    .option('--agent <name>', 'run as this agent definition (.claude/agents/<name>.md)')
    .option(
      '--account <name>',
      'start on this account, or "best" (the default): the pick order, spread across workers',
    )
    .option('--model <model>', 'the model to run')
    .option(
      '--output <format>',
      'json (the default), stream-json or text, as claude -p --output-format',
    )
    .option(
      '--permission-mode <mode>',
      "Claude's permission mode, e.g. acceptEdits; a worker cannot stop to ask",
    )
    .option(
      '--cwd <dir>',
      'work in this folder (one git worktree per coder keeps them out of each other)',
    )
    .option('--brief-file <path>', 'read the brief from a file, or - for standard input')
    .option(
      '--timeout <minutes>',
      'end the worker, Claude and everything it started after this long (exit code 124)',
    )
    .argument('[brief...]', 'the task, best quoted as one argument')
    .action(async (brief: string[], opts: WorkerOptions) => {
      const { words, passthrough } = splitPassthrough(argv(), brief);
      await run(words, opts, passthrough);
    });
}

function readBrief(briefFile: string): string {
  return briefFile === '-' ? readFileSync(0, 'utf8') : readFileSync(briefFile, 'utf8');
}

export async function workerCommand(
  context: CliContext,
  words: string[],
  options: WorkerOptions,
  passthrough: string[] = [],
  io: WorkerIo = processIo,
): Promise<number> {
  const say = context.err ?? ((m: string) => process.stderr.write(`${m}\n`));
  const output = (options.output ?? 'json') as Output;
  if (!OUTPUTS.includes(output)) {
    say(`ccx worker: --output is one of ${OUTPUTS.join(', ')}`);
    return 2;
  }
  /** Refused before anything started: said, and in the output's own shape too, so a program reads why. */
  const refuse = (why: string): number => {
    say(`ccx worker: ${why}`);
    if (output !== 'text')
      io.stdout(
        workerOutput(output, '', { accounts: [], moves: 0, sessionId: null, error: why }).stdout,
      );
    return 2;
  };

  if (options.briefFile !== undefined && words.length > 0) {
    return refuse('give the brief as words or with --brief-file, not both');
  }
  const owned = passthrough.find((arg) => WORKER_OWNED_FLAGS.has(arg.split('=')[0] ?? arg));
  if (owned !== undefined) {
    return refuse(
      `${owned.split('=')[0] ?? owned} is the worker's own (see ccx worker --help), not one to pass to Claude`,
    );
  }
  let brief: string;
  try {
    brief = options.briefFile !== undefined ? readBrief(options.briefFile) : words.join(' ');
  } catch (err) {
    return refuse(`could not read the brief: ${(err as Error).message}`);
  }
  if (brief.trim() === '') {
    return refuse(
      'no brief given (as words, --brief-file <path>, or --brief-file - for standard input)',
    );
  }
  if (brief.includes('\0')) return refuse('the brief contains a NUL character');

  if (options.cwd !== undefined) {
    if (!existsSync(options.cwd) || !statSync(options.cwd).isDirectory())
      return refuse(`no folder at ${options.cwd}`);
    // Claude works where it is started, and the session says where it runs.
    process.chdir(options.cwd);
  }

  const minutes = options.timeout === undefined ? null : Number(options.timeout);
  if (minutes !== null && !(Number.isFinite(minutes) && minutes > 0)) {
    return refuse('--timeout is a number of minutes above 0');
  }
  // The longest a timer can wait; Node runs a longer one at once.
  if (minutes !== null && minutes * 60_000 > MAX_TIMER_MS) {
    return refuse(`--timeout is at most ${Math.floor(MAX_TIMER_MS / 60_000)} minutes`);
  }

  const registered = listAccounts(context.ctx);
  if (registered.length === 0) return refuse('no accounts registered (run: ccx add <name>)');
  const account =
    options.account === undefined || options.account === 'best' ? undefined : options.account;
  if (account !== undefined && !registered.some((a) => a.name === account)) {
    return refuse(`no account named "${account}" (ccx list shows them, or use --account best)`);
  }

  // Named here rather than by the session, so the report can say which
  // conversation to look in, and so a move resumes exactly this one. Last, so
  // it also ends any option among Claude's flags that takes every value after
  // it, and the brief after it is read as the brief.
  let sessionId: string | null = randomUUID();
  const args = [
    '-p',
    '--output-format',
    output,
    // Claude requires it for stream-json in print mode.
    ...(output === 'stream-json' ? ['--verbose'] : []),
    ...(options.agent ? ['--agent', options.agent] : []),
    ...(options.model ? ['--model', options.model] : []),
    ...(options.permissionMode ? ['--permission-mode', options.permissionMode] : []),
    ...passthrough,
    '--session-id',
    sessionId,
  ];

  const accountsRun: string[] = [];
  /** What the launch running now printed: only the one that finished is the answer. */
  let launchStdout = '';
  /** The last of Claude's error lines on the launch running now, to say why there is no answer. */
  let launchStderr = '';
  /** stream-json: the part of a line not yet ended, and whether the launch running now gave a result. */
  let partial = '';
  let sawResult = false;
  /** The last thing ccx said, which is the reason when no launch happened at all. */
  let lastSaid: string | null = null;
  const workerContext: CliContext = {
    ...context,
    err: (message: string) => {
      lastSaid = message.replace(/^\[?ccx\]?:?\s*/, '');
      say(message);
    },
  };

  // Ended by whoever started it, or by its own timeout: either way Claude and
  // everything it started are stopped by ccx, while their tree is whole. An
  // orchestrator that bounds a worker with --timeout never has to kill it
  // from outside, which on Windows cannot reach what Claude's tools started.
  const interruption = handleInterruption(undefined, io.signals);
  const deadline =
    minutes === null
      ? null
      : setTimeout(
          () => interruption.end(124, `timed out after ${minutes} minutes`),
          minutes * 60_000,
        );
  // Never what keeps the process alive: Claude running is.
  deadline?.unref();
  let runCode: number;
  try {
    runCode = await runInteractiveHotSwap(workerContext, args, {
      ...(account !== undefined ? { account } : {}),
      resumePrompt: WORKER_CARRY_ON,
      worker: {
        brief,
        interruption,
        onAccount: (name) => {
          accountsRun.push(name);
        },
        onLaunch: (conversation) => {
          if (conversation) sessionId = conversation;
          launchStdout = '';
          launchStderr = '';
          // A line cut off when its launch was ended is no event: dropped.
          partial = '';
          sawResult = false;
        },
        onStdout: (chunk) => {
          if (output !== 'stream-json') {
            launchStdout += chunk;
            return;
          }
          // Whole lines only, so a launch ended mid-line cannot glue half an
          // event onto the next launch's first.
          partial += chunk;
          const end = partial.lastIndexOf('\n');
          if (end < 0) return;
          const lines = partial.slice(0, end + 1);
          partial = partial.slice(end + 1);
          for (const line of lines.split('\n')) {
            if (line.trim() === '') continue;
            const event = resultObject(line);
            if (event?.type === 'result') sawResult = true;
          }
          io.stdout(lines);
        },
        onStderr: (chunk) => {
          launchStderr = (launchStderr + chunk).slice(-2000);
          io.stderr(chunk);
        },
      },
    });
  } finally {
    if (deadline) clearTimeout(deadline);
    interruption.dispose();
  }
  // The session's own code, which is the timeout's or the signal's whenever
  // ending the worker stopped work. An end that came after Claude had answered
  // (during the session's clean-up) changes nothing.
  const exitCode = runCode;
  // A last event without its line ending is passed on whole; half of one,
  // from a launch that was ended, is not an event at all.
  const last = output === 'stream-json' && partial.trim() !== '' ? resultObject(partial) : null;
  if (last) {
    io.stdout(`${partial.trim()}\n`);
    if (last.type === 'result') sawResult = true;
  }

  // Consecutive stays on one account (a fresh start after a resume that found
  // nothing) are one stay there, not a move.
  const accounts = accountsRun.filter((name, i) => i === 0 || accountsRun[i - 1] !== name);
  const answered =
    output === 'json'
      ? resultObject(launchStdout) !== null
      : output === 'stream-json'
        ? sawResult
        : exitCode === 0 || launchStdout.trim() !== '';
  // Why the run was ended, when ending it is what stopped the work: then the
  // output says so, whatever an earlier launch printed.
  const endedIt =
    interruption.exitCode !== null && interruption.exitCode === exitCode ? interruption.why : null;
  let error: string | undefined = endedIt ?? undefined;
  if (error === undefined && !answered) {
    const lastError = launchStderr
      .split('\n')
      .filter((line) => line.trim() !== '')
      .pop();
    error =
      accounts.length === 0
        ? (lastSaid ?? 'no account could run it')
        : `Claude ended (exit code ${exitCode}) without a result${lastError ? `: ${lastError.trim()}` : ''}`;
  }
  const report: WorkerReport = {
    accounts,
    moves: Math.max(0, accounts.length - 1),
    sessionId: accounts.length > 0 ? sessionId : null,
    ...(error !== undefined ? { error } : {}),
  };
  const shaped = workerOutput(output, launchStdout, report);
  if (shaped.stdout) io.stdout(shaped.stdout);
  if (shaped.stderr) io.stderr(shaped.stderr);
  // No answer is a failure even when Claude's own exit said otherwise.
  return error !== undefined && exitCode === 0 ? 1 : exitCode;
}
