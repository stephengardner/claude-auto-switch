import { execa } from 'execa';
import { withoutEnv } from '../launcher/child-env.js';

export interface RunOptions {
  /** Extra environment variables (merged on top of process.env). */
  env?: NodeJS.ProcessEnv;
  /**
   * Variables of process.env the command must not inherit, such as the login
   * variables that would outrank the account a Claude is meant to run as.
   */
  dropEnv?: readonly string[];
  cwd?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** The environment options for execa: process.env with `env` over it, less `dropEnv`. */
function envOptions(opts: RunOptions): { env?: NodeJS.ProcessEnv; extendEnv?: boolean } {
  if (!opts.dropEnv) return { env: opts.env };
  return { env: { ...withoutEnv(process.env, opts.dropEnv), ...opts.env }, extendEnv: false };
}

/**
 * Run a command and capture its FULL stdout/stderr, then return them with the
 * exit code. Never truncates the output pipe: doing so corrupts the child's
 * exit code (spec 6.3, observed against the real CLI). Non-zero exit is returned
 * as data, not thrown.
 */
export async function runCapture(
  bin: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const result = await execa(bin, args, {
    reject: false,
    stripFinalNewline: false,
    ...envOptions(opts),
    cwd: opts.cwd,
  });
  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    exitCode: result.exitCode ?? 1,
  };
}

/**
 * Run a command with inherited stdio so the user talks to the child directly
 * (interactive passthrough for `claude`). Returns the child's exit code.
 */
export async function runInherit(
  bin: string,
  args: string[],
  opts: RunOptions = {},
): Promise<number> {
  const result = await execa(bin, args, {
    reject: false,
    stdio: 'inherit',
    ...envOptions(opts),
    cwd: opts.cwd,
  });
  return result.exitCode ?? 1;
}
