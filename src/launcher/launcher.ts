import { spawn } from 'node:child_process';
import { runInherit, runCapture, type RunOptions, type RunResult } from '../util/exec.js';
import { invokerArgs, type ClaudeInvoker } from '../invoker.js';
import { classifyRun, type CapClassification } from './cap-detect.js';

export interface LaunchTarget {
  name: string;
  dir: string;
}

export interface LaunchDeps {
  claude: ClaudeInvoker;
  /** Injectable runner (defaults to runInherit); tests substitute a fake. */
  run?: (bin: string, args: string[], opts?: RunOptions) => Promise<number>;
}

export interface LaunchResult {
  exitCode: number;
}

/**
 * Launch claude on an account with inherited stdio (interactive passthrough).
 * Returns the raw exit code.
 */
export async function launch(
  args: string[],
  account: LaunchTarget,
  deps: LaunchDeps,
): Promise<LaunchResult> {
  const run = deps.run ?? runInherit;
  const argv = invokerArgs(deps.claude, args);
  const exitCode = await run(deps.claude.bin, argv, {
    env: { CLAUDE_CONFIG_DIR: account.dir },
  });
  return { exitCode };
}

export type HeadlessRunner = (
  bin: string,
  args: string[],
  opts?: RunOptions,
) => Promise<RunResult>;

export interface HeadlessDeps {
  claude: ClaudeInvoker;
  run?: HeadlessRunner;
}

export interface HeadlessResult extends RunResult {
  classification: CapClassification;
}

/**
 * Launch claude on an account capturing full output, then classify the outcome
 * (ok / capped / error). Used by the auto-rotation loop for headless runs, where
 * we must read stderr to detect a usage cap.
 */
export async function launchHeadless(
  args: string[],
  account: LaunchTarget,
  deps: HeadlessDeps,
): Promise<HeadlessResult> {
  const run = deps.run ?? runCapture;
  const argv = invokerArgs(deps.claude, args);
  const result = await run(deps.claude.bin, argv, {
    env: { CLAUDE_CONFIG_DIR: account.dir },
  });
  return { ...result, classification: classifyRun(result) };
}

export interface WatchedResult {
  exitCode: number;
  classification: CapClassification;
}

/**
 * Launch claude for an INTERACTIVE session: stdin and stdout are inherited (fully
 * transparent for the TUI and the extension's protocol) while stderr is echoed
 * through AND watched for the rate-limit signal. We cannot hot-swap a live
 * session, but detecting the cap here lets the NEXT session rotate.
 */
export async function launchWatched(
  args: string[],
  account: LaunchTarget,
  deps: LaunchDeps,
): Promise<WatchedResult> {
  const argv = invokerArgs(deps.claude, args);
  const child = spawn(deps.claude.bin, argv, {
    env: { ...process.env, CLAUDE_CONFIG_DIR: account.dir },
    stdio: ['inherit', 'inherit', 'pipe'],
  });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });

  return { exitCode, classification: classifyRun({ exitCode, stderr }) };
}
