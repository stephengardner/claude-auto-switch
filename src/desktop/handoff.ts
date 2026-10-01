import { spawnSync } from 'node:child_process';
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

/** The `ccx run` arguments that carry the conversation on. */
export function continuationArgs(target: HandoffTarget, settings: HandoffSettings): string[] {
  return [
    'run',
    ...(settings.account ? ['--account', settings.account] : []),
    '--resume-prompt',
    settings.prompt,
    ...(settings.startPrompt ? ['--start-prompt', settings.startPrompt] : []),
    '--',
    '--resume',
    target.sessionId,
    ...(settings.mode === 'fork' ? ['--fork-session'] : []),
    ...(target.model ? ['--model', target.model] : []),
    ...(target.effort ? ['--effort', target.effort] : []),
    ...permissionArgs(target.permissionMode),
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
  return { model: value('model'), effort: value('effort'), permissionMode: value('permission-mode') };
}

/**
 * How a running Claude was started, best effort. Desktop sets the model, the
 * effort and the permission mode on the command line of each session, so that
 * is where they are read from. Null fields when it cannot be read.
 */
export function readProcessFlags(pid: number, platform: NodeJS.Platform = process.platform): ProcessFlags {
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
export function handedOffRecently(sessionId: string, c: PathCtx = {}, now = Date.now()): number | null {
  const at = readState(c)[sessionId];
  return at !== undefined && now - at < HANDOFF_QUIET_MS ? at : null;
}

function recordHandoff(sessionId: string, c: PathCtx, now: number): void {
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
  | { ok: true; via: string; script: string; command: string[] }
  | { ok: false; reason: string };

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
  const command = [ccx.node, ccx.cli, ...continuationArgs(target, settings)];
  const title = `ccx: ${target.name || target.sessionId.slice(0, 8)}`;
  const result: TerminalResult = openTerminal(
    {
      cwd: target.cwd,
      title,
      command,
      ...(waitFor !== undefined ? { gate: [ccx.node, ccx.cli, 'desktop', 'wait', String(waitFor)] } : {}),
      scriptDir: path.join(configHome(c), 'handoffs'),
      scriptName: target.sessionId,
    },
    deps,
  );
  if (!result.ok) return result;
  recordHandoff(target.sessionId, c, now);
  return { ok: true, via: result.via, script: result.script, command };
}
