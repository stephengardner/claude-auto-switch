import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configHome, type PathCtx } from '../config/paths.js';
import { readJsonFile, writeJsonFile } from '../util/fs-json.js';
import { z } from 'zod';
import { openTerminal, type TerminalDeps, type TerminalResult } from './terminal.js';

/**
 * Carrying a Claude Desktop conversation on in a terminal ccx controls.
 *
 * Desktop cannot switch accounts, so the conversation moves instead: a new
 * terminal opens in the conversation's folder and runs it through ccx, which
 * resumes it on an account with room and carries on by itself. Desktop and ccx
 * share the same conversation store, so nothing is copied by hand.
 */

export type HandoffMode = 'fork' | 'same';

/** The conversation being handed over, and how it was running in Desktop. */
export interface HandoffTarget {
  sessionId: string;
  cwd: string;
  /** Desktop's title, for the window. */
  name: string;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
}

export interface HandoffSettings {
  mode: HandoffMode;
  /** Armed for every swap after this one, so an unattended run keeps going. */
  prompt: string;
  /** Submitted once when it picks up, instead of `prompt` (a message held back from Desktop). */
  startPrompt?: string;
  /** Start on this account instead of letting ccx choose. */
  account?: string;
}

/**
 * The flags that keep a session in the permission mode it had in Desktop.
 * Without them an unattended continuation stops at its first permission
 * prompt, with nobody there to answer it.
 */
export function permissionArgs(mode: string | null | undefined): string[] {
  if (!mode || mode === 'default') return [];
  if (mode === 'bypassPermissions') return ['--dangerously-skip-permissions'];
  return ['--permission-mode', mode];
}

/**
 * What carries the conversation on: `ccx run`'s options and Claude's own
 * arguments. Written to a file that the launcher hands to ccx, rather than
 * spelled out on the launcher's command line. Windows PowerShell 5.1 splits an
 * argument with a double quote in it when it calls a program, and a whole
 * command line is capped at 32,767 characters, and a held message can run into
 * either one.
 */
export interface LaunchSpec {
  account?: string;
  resumePrompt: string;
  startPrompt?: string;
  claudeArgs: string[];
}

const LaunchSpecSchema = z.object({
  account: z.string().min(1).optional(),
  resumePrompt: z.string(),
  startPrompt: z.string().optional(),
  claudeArgs: z.array(z.string()),
});

export function launchSpec(target: HandoffTarget, settings: HandoffSettings): LaunchSpec {
  return {
    ...(settings.account ? { account: settings.account } : {}),
    resumePrompt: settings.prompt,
    ...(settings.startPrompt ? { startPrompt: settings.startPrompt } : {}),
    claudeArgs: [
      '--resume',
      target.sessionId,
      ...(settings.mode === 'fork' ? ['--fork-session'] : []),
      ...(target.model ? ['--model', target.model] : []),
      ...(target.effort ? ['--effort', target.effort] : []),
      ...permissionArgs(target.permissionMode),
    ],
  };
}

/** A launch spec handOff wrote, or null when the file is missing or not one. */
export function readLaunchSpec(file: string): LaunchSpec | null {
  try {
    const parsed = LaunchSpecSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed.success) return null;
    const { account, startPrompt, ...rest } = parsed.data;
    return {
      ...rest,
      ...(account !== undefined ? { account } : {}),
      ...(startPrompt !== undefined ? { startPrompt } : {}),
    };
  } catch {
    return null;
  }
}

/** The same as the `ccx run` command someone could type, shown by `--dry-run`. */
export function continuationArgs(target: HandoffTarget, settings: HandoffSettings): string[] {
  const spec = launchSpec(target, settings);
  return [
    'run',
    ...(spec.account ? ['--account', spec.account] : []),
    '--resume-prompt',
    spec.resumePrompt,
    ...(spec.startPrompt ? ['--start-prompt', spec.startPrompt] : []),
    '--',
    ...spec.claudeArgs,
  ];
}

/** The flags a running Claude was started with, read from its command line. */
export interface ProcessFlags {
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
}

/** Pick the flags out of a command line. Pure, so it is tested on real ones. */
export function parseFlags(commandLine: string): ProcessFlags {
  const value = (flag: string): string | null => {
    const match = new RegExp(`--${flag}(?:=|\\s+)"?([^\\s"]+)`).exec(commandLine);
    return match ? (match[1] as string) : null;
  };
  return {
    model: value('model'),
    effort: value('effort'),
    permissionMode: value('permission-mode'),
  };
}

/**
 * How a running Claude was started, best effort. Desktop sets the model, the
 * effort and the permission mode on the command line of each session, so that
 * is where they are read from. Null fields when it cannot be read.
 */
export function readProcessFlags(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): ProcessFlags {
  const none: ProcessFlags = { model: null, effort: null, permissionMode: null };
  if (!Number.isInteger(pid) || pid <= 0) return none;
  try {
    const result =
      platform === 'win32'
        ? spawnSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
            ],
            { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
          )
        : spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 });
    return result.status === 0 && result.stdout ? parseFlags(result.stdout) : none;
  } catch {
    return none;
  }
}

/* ------------------------------------------------------------------ */
/* Remembering what was handed over, so nothing is handed over twice. */
/* ------------------------------------------------------------------ */

const StateSchema = z.object({ handoffs: z.record(z.string(), z.number()).default({}) });

/** How long a conversation, once handed over, is not handed over again. */
export const HANDOFF_QUIET_MS = 15 * 60_000;

function statePath(c: PathCtx): string {
  return path.join(configHome(c), 'desktop-handoffs.json');
}

function readState(c: PathCtx): Record<string, number> {
  try {
    return readJsonFile(statePath(c), StateSchema)?.handoffs ?? {};
  } catch {
    return {};
  }
}

/** When this conversation was last handed over, if recently. */
export function handedOffRecently(
  sessionId: string,
  c: PathCtx = {},
  now = Date.now(),
): number | null {
  const at = readState(c)[sessionId];
  return at !== undefined && now - at < HANDOFF_QUIET_MS ? at : null;
}

export function recordHandoff(sessionId: string, c: PathCtx, now: number): void {
  // Only recent ones are worth keeping; the file never grows without bound.
  const kept = Object.fromEntries(
    Object.entries(readState(c)).filter(([, at]) => now - at < HANDOFF_QUIET_MS),
  );
  try {
    writeJsonFile(statePath(c), { handoffs: { ...kept, [sessionId]: now } });
  } catch {
    /* the handover happened; failing to remember it only risks a second window */
  }
}

/**
 * Forget the handover recorded at `at`, which did not happen after all, so the
 * conversation is not held back for a terminal that never opened. A record
 * made since then is left alone.
 */
export function forgetHandoff(sessionId: string, at: number, c: PathCtx = {}): void {
  const state = readState(c);
  if (state[sessionId] !== at) return;
  delete state[sessionId];
  try {
    writeJsonFile(statePath(c), { handoffs: state });
  } catch {
    /* it lapses by itself after HANDOFF_QUIET_MS */
  }
}

/** Launchers and jobs older than this have done their work, or never will. */
const HANDOFF_FILES_KEEP_MS = 24 * 60 * 60_000;

function sweepHandoffFiles(dir: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // no folder yet
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > HANDOFF_FILES_KEEP_MS) rmSync(file, { force: true });
    } catch {
      /* in use, or gone already */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Doing it.                                                           */
/* ------------------------------------------------------------------ */

export interface HandoffDeps extends TerminalDeps {
  /** The node and ccx entry point the new terminal runs. Injected in tests. */
  ccx?: { node: string; cli: string };
  now?: () => number;
}

/** This ccx, as the program a new terminal runs. */
export function thisCcx(): { node: string; cli: string } {
  return { node: process.execPath, cli: fileURLToPath(new URL('../cli.js', import.meta.url)) };
}

export type HandoffResult =
  { ok: true; via: string; script: string; command: string[] } | { ok: false; reason: string };

/**
 * Hand `target` over to a new terminal window running ccx.
 *
 * `waitFor` is the Desktop process still holding the conversation, when there
 * is one: the window then waits for it to finish its turn (or be stopped)
 * before picking the conversation up, so two processes never write into it.
 */
export function handOff(
  target: HandoffTarget,
  settings: HandoffSettings,
  c: PathCtx = {},
  deps: HandoffDeps = {},
  waitFor?: number,
): HandoffResult {
  const now = (deps.now ?? (() => Date.now()))();
  const ccx = deps.ccx ?? thisCcx();
  const title = `ccx: ${target.name || target.sessionId.slice(0, 8)}`;
  const scriptDir = path.join(configHome(c), 'handoffs');
  // File ages are real time, whatever clock the caller keeps.
  sweepHandoffFiles(scriptDir, Date.now());
  const launchFile = path.join(scriptDir, `${target.sessionId}.launch.json`);
  try {
    writeJsonFile(launchFile, launchSpec(target, settings));
  } catch (error) {
    return { ok: false, reason: `could not write ${launchFile}: ${(error as Error).message}` };
  }
  const command = [ccx.node, ccx.cli, 'desktop-run', launchFile];
  const result: TerminalResult = openTerminal(
    {
      cwd: target.cwd,
      title,
      command,
      ...(waitFor !== undefined
        ? { gate: [ccx.node, ccx.cli, 'desktop', 'wait', String(waitFor)] }
        : {}),
      scriptDir,
      scriptName: target.sessionId,
    },
    deps,
  );
  if (!result.ok) return result;
  recordHandoff(target.sessionId, c, now);
  return { ok: true, via: result.via, script: result.script, command };
}

/* ------------------------------------------------------------------ */
/* Handing over from inside a hook.                                    */
/* ------------------------------------------------------------------ */

/**
 * A handover worked out in a hook and carried out after it, by a process of
 * its own.
 *
 * A hook holds Claude up until it returns, and Claude can end it early: a
 * Claude that is exiting takes its hooks with it (measured: the one-shot CLI
 * exits straight after a failed turn and the hook's work died half done).
 * Reading a process's command line takes PowerShell a second or two on
 * Windows. So the hook only decides, writes the job down and starts a detached
 * ccx to do the rest, and is gone in the time it takes to start one.
 */
export interface HandoffJob {
  target: HandoffTarget;
  settings: HandoffSettings;
  /** Fill model, effort and permission mode from this process's command line. */
  flagsFrom?: number;
  /** The Desktop process to wait for before picking the conversation up. */
  waitFor?: number;
  /** When the hook recorded the handover; set by scheduleHandoff. */
  scheduledAt?: number;
}

function jobPath(sessionId: string, c: PathCtx): string {
  return path.join(configHome(c), 'handoffs', `${sessionId}.job.json`);
}

/** Start a detached ccx on `job`. False when it could not even be written down. */
export function scheduleHandoff(
  job: HandoffJob,
  c: PathCtx = {},
  start: (file: string) => void = (file) => {
    const ccx = thisCcx();
    const child = spawn(ccx.node, [ccx.cli, 'desktop-continue', file], {
      detached: true,
      stdio: 'ignore',
      // A node process with no window of its own; it opens the terminal itself.
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  },
  now = Date.now(),
): boolean {
  const file = jobPath(job.target.sessionId, c);
  try {
    writeJsonFile(file, { ...job, scheduledAt: now });
  } catch {
    return false;
  }
  // Marked now, not when the window opens: a second failed turn arriving while
  // the first is still being handed over must not open a second window.
  recordHandoff(job.target.sessionId, c, now);
  start(file);
  return true;
}

/** Carry out a job `scheduleHandoff` wrote, then remove it. */
export function runHandoffJob(
  file: string,
  c: PathCtx = {},
  deps: HandoffDeps & { flagsOf?: (pid: number) => ProcessFlags; handOff?: typeof handOff } = {},
): HandoffResult {
  let job: HandoffJob;
  try {
    job = JSON.parse(readFileSync(file, 'utf8')) as HandoffJob;
  } catch {
    return { ok: false, reason: `could not read ${file}` };
  } finally {
    try {
      rmSync(file, { force: true });
    } catch {
      /* a leftover job file is swept with the handoffs folder's other files */
    }
  }
  const target = { ...job.target };
  if (job.flagsFrom !== undefined && (!target.model || !target.effort || !target.permissionMode)) {
    const flags = (deps.flagsOf ?? readProcessFlags)(job.flagsFrom);
    target.model = target.model || flags.model;
    target.effort = target.effort || flags.effort;
    target.permissionMode = target.permissionMode || flags.permissionMode;
  }
  const result = (deps.handOff ?? handOff)(target, job.settings, c, deps, job.waitFor);
  if (!result.ok && job.scheduledAt !== undefined) {
    forgetHandoff(target.sessionId, job.scheduledAt, c);
  }
  return result;
}

/**
 * The model a conversation last answered with, from the end of its transcript.
 * Fast where reading the process is slow; null for a conversation that has not
 * answered yet.
 */
export function lastModelIn(transcriptPath: string): string | null {
  try {
    const size = statSync(transcriptPath).size;
    const length = Math.min(size, 256 * 1024);
    const fd = openSync(transcriptPath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const lines = buffer.toString('utf8').split('\n').reverse();
      for (const line of lines) {
        if (!line.includes('"type":"assistant"')) continue;
        // A subagent's turn, kept inline by older Claude versions, is not the conversation's model.
        if (line.includes('"isSidechain":true')) continue;
        const match = /"model":"([^"]+)"/.exec(line);
        if (match && match[1] !== '<synthetic>') return match[1] as string;
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    /* no transcript yet */
  }
  return null;
}
