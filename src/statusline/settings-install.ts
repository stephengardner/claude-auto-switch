import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { defaultClaudeRoot } from '../session/shared-root.js';
import { configHome } from '../config/paths.js';
import type { PathCtx } from '../config/paths.js';

/**
 * Wiring ccx into Claude's own status line, automatically.
 *
 * Without this, a fresh machine gives no sign that ccx is running: the shim is
 * transparent by design, so `claude` looks exactly like `claude`. That is the
 * right default for the command, and the wrong default for knowing whether
 * your account switching is on. Claude's status line is the one piece of the
 * screen ccx can write to during a session without stepping on the interface.
 *
 * This is the ONLY thing ccx writes into ~/.claude, and it writes exactly one
 * key. The planning is pure and separate from the file work because the file
 * belongs to the user: hooks, permissions and MCP servers live in it, and
 * losing them to a careless write would be far worse than having no status
 * line at all.
 */

export const CCX_COMMAND = 'ccx statusline';

/** A statusLine value in Claude's settings, in the shape Claude expects. */
export interface StatusLineValue {
  type: string;
  command: string;
  [key: string]: unknown;
}

export type InstallPlan =
  /** Nothing there before; ours goes in clean. */
  | { kind: 'installed'; settings: Record<string, unknown> }
  /** Someone else's line was there; it now runs inside ours. */
  | { kind: 'wrapped'; settings: Record<string, unknown>; displaced: unknown }
  /** Already ours. No write needed. */
  | { kind: 'already' };

/** True when this value is a status line ccx installed (wrapped or not). */
export function isOurs(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const command = (value as { command?: unknown }).command;
  return typeof command === 'string' && command.includes(CCX_COMMAND);
}

/** Shell-quote a command so wrapping someone's line survives spaces and quotes. */
export function quoteForWrap(command: string): string {
  return `"${command.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * What installing would change, given the settings as they are now.
 *
 * Every other key is carried through untouched. An existing status line is
 * never discarded: it becomes the argument to `--wrap`, so it keeps printing
 * and ccx appends to it.
 */
export function planInstall(settings: Record<string, unknown>): InstallPlan {
  const existing = settings.statusLine;
  if (isOurs(existing)) return { kind: 'already' };

  const previousCommand =
    typeof existing === 'object' && existing !== null
      ? (existing as { command?: unknown }).command
      : undefined;

  if (typeof previousCommand === 'string' && previousCommand.trim() !== '') {
    const wrapped: StatusLineValue = {
      type: 'command',
      command: `${CCX_COMMAND} --wrap ${quoteForWrap(previousCommand)}`,
    };
    return {
      kind: 'wrapped',
      settings: { ...settings, statusLine: wrapped },
      displaced: existing,
    };
  }

  const ours: StatusLineValue = { type: 'command', command: CCX_COMMAND };
  return { kind: 'installed', settings: { ...settings, statusLine: ours } };
}

export type RemovalPlan =
  /** Ours is gone and the key is empty again. */
  | { kind: 'removed'; settings: Record<string, unknown> }
  /** Ours is gone and the line that was there before is back. */
  | { kind: 'restored'; settings: Record<string, unknown> }
  /** Not ours, or not there. Left exactly as found. */
  | { kind: 'untouched' };

/**
 * What removing would change. `backup` is the value ccx displaced when it
 * installed, kept in ccx's own directory rather than parsed back out of the
 * `--wrap` argument, so restoring returns the ORIGINAL object with all of its
 * fields, not a string this code reassembled.
 *
 * A status line the user set themselves is never removed.
 */
export function planRemoval(
  settings: Record<string, unknown>,
  backup?: unknown,
): RemovalPlan {
  if (!isOurs(settings.statusLine)) return { kind: 'untouched' };

  const rest = { ...settings };
  delete rest.statusLine;

  if (backup !== undefined && backup !== null) {
    return { kind: 'restored', settings: { ...rest, statusLine: backup } };
  }
  return { kind: 'removed', settings: rest };
}

/* ------------------------------------------------------------------ */
/* File work. Everything above is pure; everything below just moves it. */
/* ------------------------------------------------------------------ */

export function settingsPath(c: PathCtx = {}): string {
  return path.join(defaultClaudeRoot(c), 'settings.json');
}

function backupPath(c: PathCtx = {}): string {
  return path.join(configHome(c), 'statusline-backup.json');
}

export type ReadResult =
  | { ok: true; settings: Record<string, unknown> }
  | { ok: false; reason: 'unreadable' };

/**
 * Read the user's settings. A file that exists but does not parse reports
 * failure rather than defaulting to empty: treating a broken file as `{}`
 * would overwrite it and take the user's hooks and permissions with it.
 */
export function readSettings(file: string): ReadResult {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return { ok: true, settings: {} };
    const text = readFileSync(file, 'utf8');
    if (text.trim() === '') return { ok: true, settings: {} };
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: 'unreadable' };
    }
    return { ok: true, settings: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

function writeSettings(file: string, settings: Record<string, unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function readBackup(c: PathCtx): unknown {
  try {
    const file = backupPath(c);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function writeBackup(c: PathCtx, value: unknown): void {
  try {
    const file = backupPath(c);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch {
    /* the status line still works without a restore point */
  }
}

export type InstallOutcome =
  | 'installed'
  | 'wrapped'
  | 'already'
  | 'unreadable'
  | 'failed';

/** Put ccx into the user's Claude status line. Safe to run repeatedly. */
export function installStatusline(c: PathCtx = {}): { outcome: InstallOutcome; file: string } {
  let file: string;
  try {
    file = settingsPath(c);
  } catch {
    return { outcome: 'failed', file: '' };
  }

  const read = readSettings(file);
  if (!read.ok) return { outcome: 'unreadable', file };

  const plan = planInstall(read.settings);
  if (plan.kind === 'already') return { outcome: 'already', file };

  try {
    if (plan.kind === 'wrapped') writeBackup(c, plan.displaced);
    writeSettings(file, plan.settings);
  } catch {
    return { outcome: 'failed', file };
  }
  return { outcome: plan.kind, file };
}

export type RemoveOutcome = 'removed' | 'restored' | 'untouched' | 'unreadable' | 'failed';

/** Take ccx back out, putting back whatever was there before it. */
export function removeStatusline(c: PathCtx = {}): { outcome: RemoveOutcome; file: string } {
  let file: string;
  try {
    file = settingsPath(c);
  } catch {
    return { outcome: 'failed', file: '' };
  }

  const read = readSettings(file);
  if (!read.ok) return { outcome: 'unreadable', file };

  const plan = planRemoval(read.settings, readBackup(c));
  if (plan.kind === 'untouched') return { outcome: 'untouched', file };

  try {
    writeSettings(file, plan.settings);
  } catch {
    return { outcome: 'failed', file };
  }
  return { outcome: plan.kind, file };
}
