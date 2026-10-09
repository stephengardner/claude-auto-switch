import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { CasError } from '../util/errors.js';
import { shellQuote } from '../util/shell-quote.js';

/**
 * Running ccx on another machine over SSH. The command reaches it as one
 * string that its login shell parses, which may be sh, bash, zsh or fish, so
 * every word goes through `shellQuote`.
 */

/**
 * The command string ssh runs for `ccx <args>` on the other machine.
 *
 * Run through the user's own login shell, because a command started by ssh
 * gets no profile, and that is where an npm or nvm install puts ccx on the PATH.
 * `sh` only hands over to that shell, so the arguments are parsed once there.
 */
export function remoteCcxCommand(args: string[], ccx = 'ccx'): string {
  const inner = [ccx, ...args.map(shellQuote)].join(' ');
  const handOver = 'exec "${SHELL:-/bin/sh}" -l -c "$1"';
  return `sh -c ${shellQuote(handOver)} ccx-remote ${shellQuote(inner)}`;
}

/** A host as typed for ssh: refused when it could be read as an option. */
export function assertSshHost(host: string): void {
  if (!/^[A-Za-z0-9._@:%+[\]-]+$/.test(host) || host.startsWith('-')) {
    throw new CasError(`"${host}" is not a host ssh can be given safely`);
  }
}

export interface RemoteResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A remote ccx that is still running, talked to a line at a time. */
export interface RemoteSession {
  /** What it prints, a line at a time, until it exits. */
  lines: AsyncIterable<string>;
  send(line: string): void;
  /** Close its input, which is how it learns nothing more is coming. */
  end(): void;
  done(): Promise<number>;
}

export interface RemoteRunner {
  run(args: string[]): Promise<RemoteResult>;
  start(args: string[]): RemoteSession;
}

/** Exit code ssh and shells use for "command not found". */
export const COMMAND_NOT_FOUND = 127;
/** Exit code ssh uses when it could not connect or authenticate. */
export const SSH_FAILED = 255;

export interface SshRunnerOptions {
  /** How ccx is run there; `ccx` through the login shell unless told otherwise. */
  ccx?: string;
  /** The ssh program; replaced in tests. */
  sshBin?: string;
}

/**
 * ssh without a terminal on the far end (`-T`): the remote ccx is driven
 * through plain pipes. Password and passphrase prompts still work, because ssh
 * asks for those on this terminal directly rather than through its input.
 */
export function sshRunner(host: string, options: SshRunnerOptions = {}): RemoteRunner {
  assertSshHost(host);
  const sshBin = options.sshBin ?? 'ssh';
  const argv = (args: string[]) => ['-T', host, remoteCcxCommand(args, options.ccx)];

  return {
    run(args) {
      return new Promise((resolve) => {
        const child = spawn(sshBin, argv(args), { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('error', (err) => resolve({ exitCode: COMMAND_NOT_FOUND, stdout, stderr: String(err) }));
        child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
      });
    },
    start(args) {
      const child = spawn(sshBin, argv(args), { stdio: ['pipe', 'pipe', 'inherit'] });
      child.stdin.on('error', () => {
        /* the far end closed first; its exit code says why */
      });
      const done = new Promise<number>((resolve) => {
        child.on('error', () => resolve(COMMAND_NOT_FOUND));
        child.on('close', (code) => resolve(code ?? 1));
      });
      return {
        lines: createInterface({ input: child.stdout, crlfDelay: Infinity }),
        send: (line) => {
          child.stdin.write(`${line}\n`);
        },
        end: () => {
          child.stdin.end();
        },
        done: () => done,
      };
    },
  };
}
