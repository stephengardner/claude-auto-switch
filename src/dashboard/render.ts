/**
 * Pure renderer for the live dashboard: a snapshot of account state in, a
 * terminal frame string out. Kept pure (no I/O, no clock) so it is fully
 * testable; the live loop supplies the snapshot and prints the frame.
 */

export interface DashboardAccount {
  name: string;
  email?: string;
  plan?: string;
  loggedIn: boolean;
  active: boolean;
  enabled: boolean;
  /** Epoch ms the account is capped until, if currently capped. */
  cappedUntil?: number;
  priority: number;
}

export interface DashboardSnapshot {
  accounts: DashboardAccount[];
  /** Recent activity lines, oldest first. */
  events: string[];
  now: number;
  refreshMs: number;
}

export interface RenderOptions {
  color?: boolean;
  /** Interactive key hints in the footer (off for a plain one-shot print). */
  interactive?: boolean;
  /** Index of the currently-selected row (for the live cursor). */
  selected?: number;
}

const ESC = String.fromCharCode(27);
const codes = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  red: `${ESC}[31m`,
  cyan: `${ESC}[36m`,
};

function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${codes.reset}` : text;
}

function hhmm(epochMs: number, now: number): string {
  const mins = Math.max(0, Math.round((epochMs - now) / 60000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${mins % 60}m`;
}

/** The status cell for one account, most-important state first. */
function statusOf(a: DashboardAccount, now: number, color: boolean): string {
  if (!a.enabled) return paint('disabled', codes.dim, color);
  if (!a.loggedIn) return paint('logged out', codes.red, color);
  if (a.cappedUntil && a.cappedUntil > now) {
    return paint(`capped ${hhmm(a.cappedUntil, now)}`, codes.yellow, color);
  }
  return paint('ready', codes.green, color);
}

/** Render the full dashboard frame for the given snapshot. */
export function renderDashboard(snapshot: DashboardSnapshot, options: RenderOptions = {}): string {
  const color = options.color ?? true;
  const { accounts, events, now } = snapshot;

  const nameWidth = Math.max(7, ...accounts.map((a) => a.name.length));
  const emailWidth = Math.max(5, ...accounts.map((a) => (a.email ?? '').length));

  // Two-char gutter: selection cursor (>) then active marker (*). PRI is the
  // rotation priority (lower goes first); rows are already sorted by it.
  const header = paint(
    `   ${'ACCOUNT'.padEnd(nameWidth)}  ${'EMAIL'.padEnd(emailWidth)}  ${'PLAN'.padEnd(6)} ${'PRI'.padEnd(3)} STATUS`,
    codes.dim,
    color,
  );

  const rows = accounts.map((a, i) => {
    const sel = i === options.selected ? paint('>', codes.cyan, color) : ' ';
    const act = a.active ? paint('*', codes.cyan, color) : ' ';
    const name = a.active ? paint(a.name.padEnd(nameWidth), codes.bold, color) : a.name.padEnd(nameWidth);
    const email = (a.email ?? '').padEnd(emailWidth);
    const plan = (a.plan ?? '').padEnd(6);
    const pri = String(a.priority).padEnd(3);
    return `${sel}${act} ${name}  ${email}  ${plan} ${pri} ${statusOf(a, now, color)}`;
  });

  const title = paint('claude-auto-switch', codes.bold, color);
  const activeName = accounts.find((a) => a.active)?.name ?? 'none';
  const subtitle = paint(`active: ${activeName}`, codes.dim, color);

  const lines = [`${title}   ${subtitle}`, '', header, ...rows];

  if (events.length > 0) {
    lines.push('', paint('recent', codes.dim, color));
    for (const e of events.slice(-5)) lines.push(`  ${e}`);
  }

  // Key hints only make sense in the live (interactive) loop; a one-shot frame
  // gets no footer so it never implies it is refreshing.
  if (options.interactive) {
    lines.push('', paint('[j/k] move  [p]in  [e]nable  [r]otate  [q]uit', codes.dim, color));
  }

  return lines.join('\n');
}
