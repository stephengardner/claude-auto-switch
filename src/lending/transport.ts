import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import path from 'node:path';
import type { LendTransport } from '../config/config.schema.js';
import { expandTilde, type PathCtx } from '../config/paths.js';
import {
  COMMAND_NOT_FOUND,
  SSH_FAILED,
  SSH_UNAVAILABLE,
  assertSshHost,
  remoteCcxCommand,
} from '../remote/ssh.js';
import { redactSecrets, writeSecretFile } from '../util/secret-file.js';

/**
 * How a bundle reaches a receiving machine. Each transport hands it over on a
 * standard input or in an owner-only file, never on a command line, where any
 * other user of either machine could read it in the process list. What a
 * program prints is shown only with the token taken out of it.
 */

export interface Delivery {
  account: string;
  kind: 'lend' | 'revoke';
  /** The bundle, as text. */
  payload: string;
  /** Values never to show, should a program echo them back: the token being sent. */
  secrets: readonly string[];
}

export interface DeliveryResult {
  ok: boolean;
  /** What happened, for a person. Never a token. */
  detail: string;
}

export interface TransportDeps {
  /** The ssh program; replaced in tests. */
  sshBin?: string;
  /** How long one delivery may take before it is ended (default 60 s). */
  timeoutMs?: number;
  /** Where `~` in a directory points, and on which platform. */
  ctx?: PathCtx;
  /** More environment for a command, beside its CCX_LEND_* variables. */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 60_000;
/** How much of a program's output is kept: its last words are what explain a failure. */
const OUTPUT_LIMIT = 16 * 1024;

/** A transport in a few words, for a line about it. A command is named by its first word only. */
export function describeTransport(transport: LendTransport): string {
  switch (transport.type) {
    case 'ssh':
      return `ssh ${transport.host}`;
    case 'directory':
      return `directory ${transport.path}`;
    case 'command':
      return `command ${transport.run.trim().split(/\s+/)[0] ?? ''}`;
  }
}

/** Hand `delivery` to the receiver behind `transport`. Never throws. */
export async function deliver(
  transport: LendTransport,
  delivery: Delivery,
  deps: TransportDeps = {},
): Promise<DeliveryResult> {
  try {
    switch (transport.type) {
      case 'directory':
        return toDirectory(transport.path, delivery, deps);
      case 'ssh':
        return await overSsh(transport.host, transport.remoteCommand, delivery, deps);
      case 'command':
        return await toCommand(transport.run, delivery, deps);
    }
  } catch (error) {
    return {
      ok: false,
      detail: scrub(error instanceof Error ? error.message : String(error), delivery.secrets),
    };
  }
}

/** One `<account>.json` per account, replaced whole and owner-only, so a reader never sees half of one. */
function toDirectory(folder: string, delivery: Delivery, deps: TransportDeps): DeliveryResult {
  const file = path.join(expandTilde(folder, deps.ctx ?? {}), `${delivery.account}.json`);
  writeSecretFile(file, delivery.payload);
  return { ok: true, detail: `written to ${file}` };
}

async function overSsh(
  host: string,
  remoteCommand: string,
  delivery: Delivery,
  deps: TransportDeps,
): Promise<DeliveryResult> {
  assertSshHost(host);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // BatchMode: a run from cron has nobody to answer a password prompt, so it
  // fails at once rather than waiting out the timeout.
  const ran = await runWithInput(
    deps.sshBin ?? 'ssh',
    ['-T', '-o', 'BatchMode=yes', host, remoteCcxCommand([], remoteCommand)],
    delivery.payload,
    { timeoutMs },
  );
  const why = (text: string): string =>
    lastLine(text, delivery.secrets) ? `: ${lastLine(text, delivery.secrets)}` : '';
  if (ran.timedOut)
    return {
      ok: false,
      detail: `ssh to ${host} did not finish within ${Math.round(timeoutMs / 1000)}s`,
    };
  if (ran.exitCode === 0)
    return { ok: true, detail: lastLine(ran.stdout, delivery.secrets) || `handed over on ${host}` };
  if (ran.exitCode === SSH_UNAVAILABLE)
    return { ok: false, detail: `could not run ssh here${why(ran.stderr)}` };
  if (ran.exitCode === SSH_FAILED)
    return { ok: false, detail: `could not reach ${host} over ssh${why(ran.stderr)}` };
  if (ran.exitCode === COMMAND_NOT_FOUND) {
    return {
      ok: false,
      detail: `${host} could not find the command to run (set the target's remoteCommand)${why(ran.stderr)}`,
    };
  }
  return {
    ok: false,
    detail: `${host} did not take it (exit ${ran.exitCode})${why(ran.stderr || ran.stdout)}`,
  };
}

async function toCommand(
  run: string,
  delivery: Delivery,
  deps: TransportDeps,
): Promise<DeliveryResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const name = run.trim().split(/\s+/)[0] ?? run;
  const ran = await runWithInput(run, null, delivery.payload, {
    timeoutMs,
    env: {
      ...process.env,
      ...deps.env,
      CCX_LEND_ACCOUNT: delivery.account,
      CCX_LEND_KIND: delivery.kind,
    },
  });
  const said = lastLine(ran.stderr || ran.stdout, delivery.secrets);
  if (ran.timedOut)
    return { ok: false, detail: `${name} did not finish within ${Math.round(timeoutMs / 1000)}s` };
  if (ran.exitCode === 0)
    return { ok: true, detail: lastLine(ran.stdout, delivery.secrets) || `handed to ${name}` };
  return { ok: false, detail: `${name} failed (exit ${ran.exitCode})${said ? `: ${said}` : ''}` };
}

interface Ran {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a program with `input` on its standard input and keep the tail of what it
 * prints. `args` null runs `file` as a shell command line (a command transport).
 */
function runWithInput(
  file: string,
  args: string[] | null,
  input: string,
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<Ran> {
  return new Promise((resolve) => {
    const spawnOptions: SpawnOptionsWithoutStdio = {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(options.env ? { env: options.env } : {}),
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child =
        args === null
          ? spawn(file, { ...spawnOptions, shell: true })
          : spawn(file, args, spawnOptions);
    } catch (error) {
      resolve({
        exitCode: SSH_UNAVAILABLE,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr: stderr || error || '', timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // Settled now rather than at close: a program the shell started can keep
      // the pipes open after the shell itself has ended, as on Windows it does.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      finish(1);
    }, options.timeoutMs);
    const keep = (sofar: string, chunk: Buffer): string =>
      (sofar + chunk.toString('utf8')).slice(-OUTPUT_LIMIT);
    child.stdout.on('data', (chunk: Buffer) => (stdout = keep(stdout, chunk)));
    child.stderr.on('data', (chunk: Buffer) => (stderr = keep(stderr, chunk)));
    child.on('error', (error) => finish(SSH_UNAVAILABLE, error.message));
    child.on('close', (code) => finish(code ?? 1));
    child.stdin.on('error', () => {
      /* it ended before reading all of it; its exit says how it went */
    });
    child.stdin.end(input);
  });
}

/** `text` with every secret in it, and anything shaped like a token, taken out. */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join('***');
  }
  return redactSecrets(out);
}

/** The last line a program printed, scrubbed and kept short. */
function lastLine(text: string, secrets: readonly string[]): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .pop();
  return line ? scrub(line, secrets).slice(0, 300) : '';
}
