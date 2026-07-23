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

/** Plain status text for an account, most-important state first. */
function statusText(a: DashboardAccount, now: number): string {
  if (!a.enabled) return 'disabled';
  if (!a.loggedIn) return 'logged out';
  if (a.cappedUntil && a.cappedUntil > now) return `capped ${hhmm(a.cappedUntil, now)}`;
  return 'ready';
}

/** A colored status dot for an account: green ready, yellow capped, red/dim otherwise. */
function statusColor(a: DashboardAccount, now: number): string {
  if (!a.enabled) return codes.dim;
  if (!a.loggedIn) return codes.red;
  if (a.cappedUntil && a.cappedUntil > now) return codes.yellow;
  return codes.green;
}

/** Render the full dashboard frame for the given snapshot. */
export function renderDashboard(snapshot: DashboardSnapshot, options: RenderOptions = {}): string {
  const color = options.color ?? true;
  const { accounts, events, now } = snapshot;

  const nameW = Math.max('ACCOUNT'.length, ...accounts.map((a) => a.name.length));
  const emailW = Math.max('EMAIL'.length, ...accounts.map((a) => (a.email ?? '').length));
  const planW = Math.max('PLAN'.length, ...accounts.map((a) => (a.plan ?? '').length));
  const priW = 3;
  const statusW = Math.max('STATUS'.length, ...accounts.map((a) => statusText(a, now).length + 2));

  // Two-char gutter: selection cursor then active marker, both plain-text
  // visible so the active row is clear even without color.
  const rowWidth = 3 + nameW + 2 + emailW + 2 + planW + 2 + priW + 2 + statusW;
  const rule = paint('─'.repeat(rowWidth), codes.dim, color);

  const title = paint('claude-auto-switch', codes.bold, color);
  const activeName = accounts.find((a) => a.active)?.name ?? 'none';
  const titleLine = `${title}   ${paint(`active: ${activeName}`, codes.dim, color)}`;

  const header = paint(
    `   ${'ACCOUNT'.padEnd(nameW)}  ${'EMAIL'.padEnd(emailW)}  ${'PLAN'.padEnd(planW)}  ${'PRI'.padEnd(priW)}  STATUS`,
    codes.dim,
    color,
  );

  const rows = accounts.map((a, i) => {
    const cursor = i === options.selected ? paint('▸', codes.cyan, color) : ' ';
    const active = a.active ? paint('*', codes.cyan, color) : ' ';
    const name = a.active
      ? paint(a.name.padEnd(nameW), `${codes.bold}${codes.cyan}`, color)
      : a.name.padEnd(nameW);
    const email = (a.email ?? '').padEnd(emailW);
    const plan = (a.plan ?? '').padEnd(planW);
    const pri = String(a.priority).padEnd(priW);
    const dot = paint('●', statusColor(a, now), color);
    return `${cursor}${active} ${name}  ${email}  ${plan}  ${pri}  ${dot} ${statusText(a, now)}`;
  });

  const lines = [titleLine, rule, header, ...rows, rule];

  if (events.length > 0) {
    for (const e of events.slice(-5)) lines.push(paint(`  ${e}`, codes.dim, color));
    lines.push(rule);
  }

  if (options.interactive) {
    lines.push(paint('j/k move  ·  p pin  ·  e enable  ·  r rotate  ·  q quit', codes.dim, color));
  }

  return lines.join('\n');
}
