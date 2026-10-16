import { spawn } from 'node:child_process';
import {
  assertSshHost,
  remoteCcxCommand,
  SSH_FAILED,
  SSH_UNAVAILABLE,
  type RemoteResult,
} from '../remote/ssh.js';

/**
 * ssh for a machine nobody is sitting at.
 *
 * `ccx login --host` runs with a person there to type a passphrase and to
 * wait. The watcher runs alone, in a service. So here ssh must never stop to
 * ask for anything, must give up on a host that does not answer, and a command
 * that hangs is ended rather than waited on: a follower that is switched off
 * must cost the watcher seconds, not its next pass.
 */
const UNATTENDED = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15'];

const DEFAULT_TIMEOUT_MS = 30_000;
/** As much of another machine's output as is kept. An answer here is a line or two. */
const MAX_OUTPUT_BYTES = 64 * 1024;
/** As much of a line from another machine as is shown or written to the history. */
const MAX_LINE_CHARS = 200;

export interface UnattendedOptions {
  /** How ccx is run there; `ccx` through the login shell unless told otherwise. */
  ccx?: string;
  /** The ssh program; replaced in tests. */
  sshBin?: string;
  /** End the command after this long. */
  timeoutMs?: number;
}

/** Run one command line on `host`, as given. */
export function runRemote(host: string, command: string, options: UnattendedOptions = {}): Promise<RemoteResult> {
  assertSshHost(host);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(options.sshBin ?? 'ssh', ['-T', ...UNATTENDED, host, command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (result: RemoteResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ exitCode: SSH_FAILED, stdout, stderr: `${stderr}timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    // Capped: what comes back is another machine's to decide, and this one's to hold.
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += d.toString();
    });
    child.on('error', (err) => settle({ exitCode: SSH_UNAVAILABLE, stdout, stderr: String(err) }));
    child.on('close', (code) => settle({ exitCode: code ?? 1, stdout, stderr }));
  });
}

/** Run `ccx <args>` on `host`, through its login shell as `ccx login --host` does. */
export function runRemoteCcx(host: string, args: string[], options: UnattendedOptions = {}): Promise<RemoteResult> {
  return runRemote(host, remoteCcxCommand(args, options.ccx), options);
}

/**
 * The last line a remote command printed that says anything, made safe to show.
 *
 * It ends up on this machine's terminal and in its history, and it was written
 * by another machine. Control characters are stripped so it cannot move the
 * cursor or recolour the screen (CWE-150), and it is cut to a line's length.
 */
export function lastLine(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim())
      .filter((l) => l !== '')
      .pop() ?? '';
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line;
}
