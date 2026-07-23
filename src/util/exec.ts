import { execa } from 'execa';

export interface RunOptions {
  /** Extra environment variables (merged on top of process.env). */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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
    env: opts.env,
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
    env: opts.env,
    cwd: opts.cwd,
  });
  return result.exitCode ?? 1;
}
