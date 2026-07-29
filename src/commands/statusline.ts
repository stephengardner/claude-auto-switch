import { spawn } from 'node:child_process';
import { getActive } from '../state/active.js';
import { readUsageSnapshot } from '../usage/usage-store.js';
import { bindingUtilization } from '../usage/headroom.js';
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
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** The window closest to its limit, e.g. "Fable 78%", or null when unknown. */
function bindingLabel(usage: {
  fiveHour: number | null;
  sevenDay: number | null;
  models?: Array<{ name: string; utilization: number }> | null;
}): string | null {
  const windows: Array<{ label: string; used: number }> = [];
  if (typeof usage.fiveHour === 'number') windows.push({ label: '5h', used: usage.fiveHour });
  if (typeof usage.sevenDay === 'number') windows.push({ label: 'wk', used: usage.sevenDay });
  for (const m of usage.models ?? []) {
    if (typeof m.utilization === 'number') windows.push({ label: m.name, used: m.utilization });
  }
  if (windows.length === 0) return null;
  const worst = windows.reduce((a, b) => (b.used > a.used ? b : a));
  return `${worst.label} ${pct(worst.used)}`;
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

/** The ccx part of the status line, e.g. "· maxed Fable 13%". */
export function statuslineSegment(context: CliContext): string {
  const active = getActive(context.ctx);
  if (!active) return 'ccx: no account selected';
  const entry = readUsageSnapshot(context.ctx).accounts[active];
  const label = entry ? bindingLabel(entry) : null;
  const used = entry ? bindingUtilization(entry) : null;
  // Quiet while there is room, louder as the account fills up, so a glance is
  // enough and nothing shouts until it matters.
  const mark = used !== null && used >= 0.9 ? '!' : '·';
  return label ? `${mark} ${active} ${label}` : `${mark} ${active}`;
}

/**
 * Run the operator's existing status line command, feeding it the same input
 * Claude gave us, and append ccx's part. Their line always wins: if ccx cannot
 * produce its part, theirs is still printed unchanged.
 */
async function wrapExisting(context: CliContext, command: string): Promise<string> {
  const stdin = await readStdin();
  let existing = '';
  try {
    existing = await runCapturing(command, stdin);
  } catch {
    existing = ''; // their command failed; still show ours rather than nothing
  }
  let ours = '';
  try {
    ours = statuslineSegment(context);
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
    context.out(await wrapExisting(context, options.wrap));
    return 0;
  }

  context.out(statuslineSegment(context));
  return 0;
}
