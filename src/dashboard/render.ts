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
  /** Subscription usage (0..1 per window), including per-model weekly windows. */
  usage?: {
    fiveHour: number | null;
    sevenDay: number | null;
    models?: Array<{ name: string; utilization: number }> | null;
  };
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
  /** A message to show above the key hints (an error, or what just happened). */
  notice?: string;
  /** The name prompt, when the dashboard is asking for one. */
  prompt?: { label: string; text: string; error?: string };
}

import { codes, paint } from '../ui/style.js';

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

/**
 * The limit that will actually stop this account, e.g. `Fable 100%`.
 *
 * An account can sit at 0% for the hour and 62% for the week and still be
 * completely unusable because one model's weekly window is spent, so the row
 * shows whichever window is closest to its limit rather than a reassuring
 * average.
 */
function bindingWindow(a: DashboardAccount): { label: string; used: number } | null {
  const u = a.usage;
  if (!u) return null;
  const windows: Array<{ label: string; used: number }> = [];
  if (typeof u.fiveHour === 'number') windows.push({ label: '5h', used: u.fiveHour });
  if (typeof u.sevenDay === 'number') windows.push({ label: 'wk', used: u.sevenDay });
  for (const m of u.models ?? []) {
    if (typeof m.utilization === 'number') windows.push({ label: m.name, used: m.utilization });
  }
  if (windows.length === 0) return null;
  return windows.reduce((worst, w) => (w.used > worst.used ? w : worst));
}

/** Plain usage text for an account: the binding window, or empty when unknown. */
function usageText(a: DashboardAccount): string {
  const binding = bindingWindow(a);
  return binding ? `${binding.label} ${Math.round(binding.used * 100)}%` : '';
}

/** Red once the binding window is spent, yellow as it approaches. */
function usageColor(a: DashboardAccount): string {
  const used = bindingWindow(a)?.used ?? 0;
  if (used >= 1) return codes.red;
  if (used >= 0.9) return codes.yellow;
  return codes.dim;
}

/** Render the full dashboard frame for the given snapshot. */
export function renderDashboard(snapshot: DashboardSnapshot, options: RenderOptions = {}): string {
  const color = options.color ?? true;
  const { accounts, events, now } = snapshot;

  const nameW = Math.max('ACCOUNT'.length, ...accounts.map((a) => a.name.length));
  const emailW = Math.max('EMAIL'.length, ...accounts.map((a) => (a.email ?? '').length));
  const planW = Math.max('PLAN'.length, ...accounts.map((a) => (a.plan ?? '').length));
  const priW = 3;
  const usageW = Math.max('USAGE'.length, ...accounts.map((a) => usageText(a).length));
  const statusW = Math.max('STATUS'.length, ...accounts.map((a) => statusText(a, now).length + 2));

  // Two-char gutter: selection cursor then active marker, both plain-text
  // visible so the active row is clear even without color.
  const rowWidth = 3 + nameW + 2 + emailW + 2 + planW + 2 + priW + 2 + usageW + 2 + statusW;
  const rule = paint('─'.repeat(rowWidth), codes.dim, color);

  const title = paint('claude-auto-switch', codes.bold, color);
  const activeName = accounts.find((a) => a.active)?.name ?? 'none';
  const titleLine = `${title}   ${paint(`active: ${activeName}`, codes.dim, color)}`;

  const header = paint(
    `   ${'ACCOUNT'.padEnd(nameW)}  ${'EMAIL'.padEnd(emailW)}  ${'PLAN'.padEnd(planW)}  ${'PRI'.padEnd(priW)}  ${'USAGE'.padEnd(usageW)}  STATUS`,
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
    const usage = paint(usageText(a).padEnd(usageW), usageColor(a), color);
    const dot = paint('●', statusColor(a, now), color);
    return `${cursor}${active} ${name}  ${email}  ${plan}  ${pri}  ${usage}  ${dot} ${statusText(a, now)}`;
  });

  const lines = [titleLine, rule, header, ...rows, rule];

  if (events.length > 0) {
    for (const e of events.slice(-5)) lines.push(paint(`  ${e}`, codes.dim, color));
    lines.push(rule);
  }

  if (options.notice) {
    lines.push(paint(`  ${options.notice}`, codes.yellow, color));
  }

  // While a name is being typed, the footer explains that box instead of the
  // normal keys, because the normal keys do not apply until it is finished.
  if (options.prompt) {
    lines.push(`  ${options.prompt.label} ${options.prompt.text}█`);
    if (options.prompt.error) {
      lines.push(paint(`  ${options.prompt.error}`, codes.yellow, color));
    }
    lines.push(paint('  enter confirm  ·  esc cancel', codes.dim, color));
  } else if (options.interactive) {
    lines.push(
      paint(
        'j/k move  ·  enter use  ·  f now  ·  a add  ·  n rename  ·  e enable  ·  r rotate  ·  q quit',
        codes.dim,
        color,
      ),
    );
  }

  return lines.join('\n');
}
