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

already using a status line? call ccx statusline from your own command and
append its output.`;

/** Print the status line (or the snippet that installs it). */
export function statuslineCommand(context: CliContext, options: StatuslineOptions = {}): number {
  if (options.install) {
    context.out(SNIPPET);
    return 0;
  }

  const active = getActive(context.ctx);
  if (!active) {
    context.out('ccx: no account selected');
    return 0;
  }

  const entry = readUsageSnapshot(context.ctx).accounts[active];
  const label = entry ? bindingLabel(entry) : null;
  const used = entry ? bindingUtilization(entry) : null;
  // A quiet marker while there is room, a louder one as the account fills up,
  // so a glance is enough and nothing shouts until it matters.
  const mark = used === null ? '·' : used >= 1 ? '!' : used >= 0.9 ? '!' : '·';

  context.out(label ? `${mark} ${active} ${label}` : `${mark} ${active}`);
  return 0;
}
