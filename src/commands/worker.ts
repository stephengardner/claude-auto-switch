import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { listAccounts } from '../accounts/registry.js';
import type { CliContext } from '../context.js';
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
}

/** What a worker's conversation is told when it resumes on another account. */
export const WORKER_CARRY_ON =
  'Your previous turn was cut off when its account ran out of usage, and this conversation now continues on ' +
  'another account. Carry on exactly where you stopped and finish the task. If it was already finished, give ' +
  'your final answer again in full.';

const OUTPUTS = ['json', 'stream-json', 'text'] as const;
type Output = (typeof OUTPUTS)[number];

/** Which accounts a worker ran on, in order, for its report. */
export interface WorkerReport {
  accounts: string[];
  /** How many times it moved to another account. */
  moves: number;
  sessionId: string;
}

/**
 * A worker's standard output: what Claude printed on the launch that
 * finished, with the report. Earlier launches ended on a spent account, and
 * what they printed was a failure the task has since recovered from, so it is
 * not passed on, except as stream-json, which is passed on as it arrives.
 */
export function workerOutput(output: Output, finalStdout: string, report: WorkerReport): { stdout: string; stderr: string } {
  const summary = reportLine(report);
  if (output === 'stream-json') {
    return { stdout: `${JSON.stringify({ type: 'ccx', ...report })}\n`, stderr: '' };
  }
  if (output === 'json') {
    try {
      const parsed: unknown = JSON.parse(finalStdout.trim());
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { stdout: `${JSON.stringify({ ...(parsed as Record<string, unknown>), ccx: report })}\n`, stderr: '' };
      }
    } catch {
      /* not one object: passed on as it was, the report beside it */
    }
  }
  return { stdout: finalStdout, stderr: `${summary}\n` };
}

/** "[ccx] worker ran on b, moved from a when it ran out (session …)". */
export function reportLine(report: WorkerReport): string {
  const last = report.accounts[report.accounts.length - 1] ?? 'no account';
  const earlier = report.accounts.slice(0, -1);
  const moved = earlier.length > 0 ? `, moved from ${earlier.join(', then ')} when it ran out` : '';
  return `[ccx] worker ran on ${last}${moved} (session ${report.sessionId})`;
}

function readBrief(words: string[], briefFile: string | undefined): string {
  if (briefFile === undefined) return words.join(' ');
  if (briefFile === '-') return readFileSync(0, 'utf8');
  return readFileSync(briefFile, 'utf8');
}

/** Where a worker writes: the process's own streams, or a test's. */
export interface WorkerIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const processIo: WorkerIo = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

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

  let brief: string;
  try {
    brief = readBrief(words, options.briefFile);
  } catch (err) {
    say(`ccx worker: could not read the brief: ${(err as Error).message}`);
    return 2;
  }
  if (brief.trim() === '') {
    say('ccx worker: no brief given (as words, --brief-file <path>, or --brief-file - for standard input)');
    return 2;
  }
  if (brief.includes('\0')) {
    say('ccx worker: the brief contains a NUL character');
    return 2;
  }

  if (options.cwd !== undefined) {
    if (!existsSync(options.cwd) || !statSync(options.cwd).isDirectory()) {
      say(`ccx worker: no folder at ${options.cwd}`);
      return 2;
    }
    // Claude works where it is started, and the session says where it runs.
    process.chdir(options.cwd);
  }

  const account = options.account === undefined || options.account === 'best' ? undefined : options.account;
  if (account !== undefined && !listAccounts(context.ctx).some((a) => a.name === account)) {
    say(`ccx worker: no account named "${account}" (ccx list shows them, or use --account best)`);
    return 2;
  }

  // Named here rather than by the session, so the report can say which
  // conversation to look in, and so a move resumes exactly this one.
  const sessionId = randomUUID();
  const args = [
    '-p',
    '--output-format',
    output,
    // Claude requires it for stream-json in print mode.
    ...(output === 'stream-json' ? ['--verbose'] : []),
    ...(options.agent ? ['--agent', options.agent] : []),
    ...(options.model ? ['--model', options.model] : []),
    ...(options.permissionMode ? ['--permission-mode', options.permissionMode] : []),
    '--session-id',
    sessionId,
    ...passthrough,
  ];

  const accountsRun: string[] = [];
  let launchStdout = '';
  const exitCode = await runInteractiveHotSwap(context, args, {
    ...(account !== undefined ? { account } : {}),
    resumePrompt: WORKER_CARRY_ON,
    worker: {
      brief,
      onLaunch: (name) => {
        accountsRun.push(name);
        launchStdout = '';
      },
      onStdout: (chunk) => {
        if (output === 'stream-json') io.stdout(chunk);
        else launchStdout += chunk;
      },
      onStderr: (chunk) => {
        io.stderr(chunk);
      },
    },
  });

  // Consecutive launches on one account (a fresh start after a resume that
  // found nothing) are one stay there, not a move.
  const accounts = accountsRun.filter((name, i) => i === 0 || accountsRun[i - 1] !== name);
  const report: WorkerReport = { accounts, moves: Math.max(0, accounts.length - 1), sessionId };
  const shaped = workerOutput(output, launchStdout, report);
  if (shaped.stdout) io.stdout(shaped.stdout);
  if (shaped.stderr) io.stderr(shaped.stderr);
  return exitCode;
}
