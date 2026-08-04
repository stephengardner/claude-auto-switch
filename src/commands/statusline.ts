import { spawn } from 'node:child_process';
import path from 'node:path';
import { getActive } from '../state/active.js';
import { listAccounts } from '../accounts/registry.js';
import { hasUsableLogin } from '../accounts/credential-vault.js';
import { configHome } from '../config/paths.js';
import { effectiveUtilization, windowIsOpen } from '../usage/window-open.js';
import { readUsageSnapshot } from '../usage/usage-store.js';
import type { CliContext } from '../context.js';

/**
 * A one-line summary of which account you are on, for Claude's own status line.
 *
 * This is the only place ccx can tell you something during a session without
 * getting in the way: Claude owns the screen while it runs, so anything ccx
 * prints is either overwritten or steps on the interface. The status line is
 * Claude's own space and it redraws it for us.
 *
 * Deliberately cheap: it reads the account pointer and the cached usage figures
 * and never touches the network, because Claude re-runs this frequently.
 */

export interface StatuslineOptions {
  /** Print the settings snippet that wires this into Claude instead of a line. */
  install?: boolean;
  /**
   * Run an existing status line command and append ccx's part to it, so adding
   * ccx does not cost you the status line you already had.
   */
  wrap?: string;
  /** Leave out the account name (useful when your line already shows it). */
  compact?: boolean;
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

interface Window {
  label: string;
  used: number;
  resetsAt?: number | null;
}

/** Every limit currently running against this account. */
function windowsOf(usage: {
  fiveHour: number | null;
  sevenDay: number | null;
  fiveHourReset?: number | null;
  sevenDayReset?: number | null;
  models?: Array<{ name: string; utilization: number; resetsAt?: number | null }> | null;
}): Window[] {
  const windows: Window[] = [];
  if (typeof usage.fiveHour === 'number') {
    windows.push({ label: '5h', used: usage.fiveHour, resetsAt: usage.fiveHourReset ?? null });
  }
  if (typeof usage.sevenDay === 'number') {
    windows.push({ label: 'week', used: usage.sevenDay, resetsAt: usage.sevenDayReset ?? null });
  }
  for (const m of usage.models ?? []) {
    if (typeof m.utilization === 'number') {
      windows.push({ label: m.name, used: m.utilization, resetsAt: m.resetsAt ?? null });
    }
  }
  return windows;
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).replace(/\\/g, '/').toLowerCase() === path.resolve(b).replace(/\\/g, '/').toLowerCase();
}

/**
 * Is ccx driving the session that asked for this line?
 *
 * Claude runs the status line command as a child of the session, so it inherits
 * that session's config location. When ccx is running things, that location is
 * one of the folders ccx hands out; when you launched Claude directly it is not.
 */
function isManagedSession(context: CliContext): boolean {
  const configDir = (context.ctx.env ?? process.env).CLAUDE_CONFIG_DIR;
  if (!configDir) return false; // plain `claude` on the default config
  const home = configHome(context.ctx);
  return (
    samePath(configDir, path.join(home, 'session')) || // terminal session
    samePath(configDir, path.join(home, 'editor-active')) // editor, following ccx
  );
}

function accountDirOf(context: CliContext, name: string): string {
  const account = listAccounts(context.ctx).find((a) => a.name === name);
  return account?.dir ?? path.join(configHome(context.ctx), 'profiles', name);
}

/** How long until a window resets, e.g. "2h" or "3d". */
function until(resetsAt: number | null | undefined, now: number): string | null {
  if (!resetsAt || resetsAt <= now) return null;
  const mins = Math.round((resetsAt - now) / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

const SNIPPET = `add this to your Claude settings.json:

  "statusLine": {
    "type": "command",
    "command": "ccx statusline"
  }

already using a status line? keep it and wrap it, so you get both:

  "statusLine": {
    "type": "command",
    "command": "ccx statusline --wrap <your existing command>"
  }`;

/**
 * The ccx part of the status line, e.g. `Fable 87% left`.
 *
 * Written to answer one question at a glance: how much working room is left
 * before something stops me. So it reports what REMAINS rather than what has
 * been spent (a bare "13%" reads as reassuring when it means nearly empty), on
 * the window that will run out first, and it only mentions the reset time once
 * that is the thing you would act on.
 */
export function statuslineSegment(context: CliContext, options: StatuslineOptions = {}): string {
  // Say nothing about accounts unless ccx is actually driving THIS session.
  // Otherwise the line reports the room on whichever account ccx would pick,
  // while you are really on a different one and nothing is watching for a
  // limit: reassuring, and wrong, which is the worst thing a status line can be.
  if (!isManagedSession(context)) return 'no ccx';

  const active = getActive(context.ctx);
  if (!active) return 'ccx: no account';
  if (!hasUsableLogin(accountDirOf(context, active))) return `! ${active} needs sign-in`;

  const entry = readUsageSnapshot(context.ctx).accounts[active];
  const name = options.compact ? '' : active;
  if (!entry) return name || 'ccx';

  const now = Date.now();
  const windows = windowsOf(entry);
  if (windows.length === 0) return name || 'ccx';
  // Judged on usage as it stands now. A window past its reset records a limit
  // that has ended, and reporting it would put a spent model on screen for an
  // account that is free: alarming and wrong, which is as bad here as
  // reassuring and wrong.
  const usedNow = (w: Window): number => effectiveUtilization(w.used, w.resetsAt, now) ?? 0;
  // On a tie an OPEN window wins, because an expired one is not a constraint at
  // all and naming it reports a limit that is not running. Ties are the normal
  // case once expired windows read as empty, and the first window listed would
  // otherwise win by accident of ordering.
  const beats = (b: Window, a: Window): boolean => {
    if (usedNow(b) !== usedNow(a)) return usedNow(b) > usedNow(a);
    return windowIsOpen(b.resetsAt, now) && !windowIsOpen(a.resetsAt, now);
  };
  // Reduce keeps the first when nothing beats it, so an all-expired account
  // still names a window rather than falling over.
  const binding = windows.reduce((a, b) => (beats(b, a) ? b : a));

  const left = Math.max(0, 1 - usedNow(binding));
  const resets = until(binding.resetsAt, now);
  const amount = left <= 0 ? `${binding.label} spent` : `${binding.label} ${pct(left)} left`;
  // The reset time is noise while there is plenty of room, and the only thing
  // that matters once there is not.
  const showReset = left <= 0.15 && resets;
  const mark = left <= 0.1 ? '!' : '';

  return [mark, name, amount, showReset ? `resets ${resets}` : '']
    .filter((part) => part.length > 0)
    .join(' ');
}

/**
 * Run the operator's existing status line command, feeding it the same input
 * Claude gave us, and append ccx's part. Their line always wins: if ccx cannot
 * produce its part, theirs is still printed unchanged.
 */
async function wrapExisting(
  context: CliContext,
  command: string,
  options: StatuslineOptions,
): Promise<string> {
  const stdin = await readStdin();
  let existing = '';
  try {
    existing = await runCapturing(command, stdin);
  } catch {
    existing = ''; // their command failed; still show ours rather than nothing
  }
  let ours = '';
  try {
    ours = statuslineSegment(context, options);
  } catch {
    ours = '';
  }
  const left = existing.replace(/\s+$/, '');
  if (!left) return ours;
  if (!ours) return left;
  return `${left}  ${ours}`;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const done = (): void => resolve(data);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    // Claude sends its payload immediately; do not hang the status line if not.
    setTimeout(done, 1000).unref?.();
  });
}

function runCapturing(command: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // shell:true so a plain command name resolves the same way it would in the
    // operator's own settings (including .cmd shims on Windows).
    const child = spawn(command, { shell: true });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', () => resolve(out));
    try {
      child.stdin.end(input);
    } catch {
      /* the command may not read stdin */
    }
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(out);
    }, 2000).unref?.();
  });
}

/** Print the status line (or the snippet that installs it). */
export async function statuslineCommand(
  context: CliContext,
  options: StatuslineOptions = {},
): Promise<number> {
  if (options.install) {
    context.out(SNIPPET);
    return 0;
  }
  if (options.wrap) {
    context.out(await wrapExisting(context, options.wrap, options));
    return 0;
  }

  context.out(statuslineSegment(context, options));
  return 0;
}
