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
  /**
   * Subscription usage (0..1 per window), including per-model weekly windows and
   * when each window comes back. The reset times are carried through so the
   * detail line can answer "when can I use this again" without another lookup.
   */
  usage?: {
    fiveHour: number | null;
    sevenDay: number | null;
    fiveHourReset?: number | null;
    sevenDayReset?: number | null;
    models?: Array<{ name: string; utilization: number; resetsAt?: number | null }> | null;
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
  /** A yes/no question waiting for an answer, shown instead of the key hints. */
  confirm?: string;
  /** The name prompt, when the dashboard is asking for one. */
  prompt?: { label: string; text: string; error?: string };
}

import { codes, paint } from '../ui/style.js';
import { effectiveUtilization, bindsHarder } from '../usage/window-open.js';

/**
 * A wait, at the coarsest useful precision: minutes within the hour, hours
 * within the day, then days. Weekly windows are days away, and printing those as
 * "72h0m" is technically right and useless to read.
 */
function hhmm(epochMs: number, now: number): string {
  const mins = Math.max(0, Math.round((epochMs - now) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
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


/** Plain usage text for an account: the binding window, or empty when unknown. */
/** The same scale everywhere: spent is red, nearly spent is amber. */
function shadeFor(used: number | null): string {
  if (used === null) return codes.dim;
  if (used >= 1) return codes.red;
  if (used >= 0.9) return codes.yellow;
  return codes.dim;
}

/** A window's utilization as a whole percent, or a dash when it is unknown. */
function pct(used: number | null | undefined): string {
  return typeof used === 'number' ? `${Math.round(used * 100)}%` : '-';
}

/**
 * The per-model window that matters, which is the one closest to its limit.
 *
 * Shown by name (for example `Fable 100%`) rather than folded into an average:
 * an account can be at 6% for the hour and still refuse to run Fable, and an
 * average hides exactly the number that stops you.
 */
function worstModel(
  a: DashboardAccount,
  now: number,
): { name: string; utilization: number; resetsAt?: number | null } | null {
  const models = (a.usage?.models ?? []).filter((m) => typeof m.utilization === 'number');
  if (models.length === 0) return null;
  // Ranked on usage as it stands now, so a window that has already reset does
  // not keep the column pinned at the number it hit before it rolled over, and
  // a tie goes to a model whose window is still running.
  const measured = (m: { utilization: number; resetsAt?: number | null }) => ({
    used: m.utilization,
    resetsAt: m.resetsAt,
  });
  return models.reduce((worst, m) =>
    bindsHarder(measured(m), measured(worst), now) ? m : worst,
  );
}

/** The worst model's usage as it stands now, for colouring the MODEL column. */
function modelUsedNow(a: DashboardAccount, now: number): number | null {
  const m = worstModel(a, now);
  return m ? effectiveUtilization(m.utilization, m.resetsAt, now) : null;
}

/** The account-wide numbers as they stand now, so a reset window reads empty. */
function fiveHourNow(a: DashboardAccount, now: number): number | null {
  return effectiveUtilization(a.usage?.fiveHour, a.usage?.fiveHourReset, now);
}
function weekNow(a: DashboardAccount, now: number): number | null {
  return effectiveUtilization(a.usage?.sevenDay, a.usage?.sevenDayReset, now);
}

function modelText(a: DashboardAccount, now: number): string {
  const m = worstModel(a, now);
  return m ? `${m.name} ${pct(effectiveUtilization(m.utilization, m.resetsAt, now))}` : '-';
}

/**
 * Everything known about the highlighted account, on one line: each window, what
 * it is at, and when it comes back. The table gives the numbers at a glance; this
 * answers "and when can I use it again" without a second command.
 */
function detailLine(a: DashboardAccount, now: number): string {
  const u = a.usage;
  if (!u) return `${a.name}: no usage read yet`;
  const parts = [
    `5h ${pct(effectiveUtilization(u.fiveHour, u.fiveHourReset, now))}${resetSuffix(u.fiveHourReset, now)}`,
    `week ${pct(effectiveUtilization(u.sevenDay, u.sevenDayReset, now))}${resetSuffix(u.sevenDayReset, now)}`,
  ];
  for (const m of u.models ?? []) {
    parts.push(
      `${m.name} ${pct(effectiveUtilization(m.utilization, m.resetsAt, now))}${resetSuffix(m.resetsAt, now)}`,
    );
  }
  return `${a.name}: ${parts.join('   ')}`;
}

/** " (back in 3h)" for a window that is in the future, otherwise nothing. */
function resetSuffix(resetsAt: number | null | undefined, now: number): string {
  if (typeof resetsAt !== 'number' || resetsAt <= now) return '';
  return ` (back in ${hhmm(resetsAt, now)})`;
}

/** Render the full dashboard frame for the given snapshot. */
export function renderDashboard(snapshot: DashboardSnapshot, options: RenderOptions = {}): string {
  const color = options.color ?? true;
  const { accounts, events, now } = snapshot;

  const nameW = Math.max('ACCOUNT'.length, ...accounts.map((a) => a.name.length));
  const emailW = Math.max('EMAIL'.length, ...accounts.map((a) => (a.email ?? '').length));
  const planW = Math.max('PLAN'.length, ...accounts.map((a) => (a.plan ?? '').length));
  const priW = 3;
  // Three separate columns instead of one collapsed number. The old single
  // column showed only whichever window was worst, so an account could read
  // "Fable 100%" with no way to see that everything else was fine, or read "6%"
  // while a model window was spent.
  const fiveW = Math.max('5H'.length, ...accounts.map((a) => pct(fiveHourNow(a, now)).length));
  const weekW = Math.max('WEEK'.length, ...accounts.map((a) => pct(weekNow(a, now)).length));
  const modelW = Math.max('MODEL'.length, ...accounts.map((a) => modelText(a, now).length));
  const statusW = Math.max('STATUS'.length, ...accounts.map((a) => statusText(a, now).length + 2));

  // Two-char gutter: selection cursor then active marker, both plain-text
  // visible so the active row is clear even without color.
  const rowWidth =
    3 + nameW + 2 + emailW + 2 + planW + 2 + priW + 2 + fiveW + 2 + weekW + 2 + modelW + 2 + statusW;
  const rule = paint('─'.repeat(rowWidth), codes.dim, color);

  const title = paint('claude-auto-switch', codes.bold, color);
  const activeName = accounts.find((a) => a.active)?.name ?? 'none';
  const titleLine = `${title}   ${paint(`active: ${activeName}`, codes.dim, color)}`;

  const header = paint(
    `   ${'ACCOUNT'.padEnd(nameW)}  ${'EMAIL'.padEnd(emailW)}  ${'PLAN'.padEnd(planW)}  ${'PRI'.padEnd(priW)}  ${'5H'.padEnd(fiveW)}  ${'WEEK'.padEnd(weekW)}  ${'MODEL'.padEnd(modelW)}  STATUS`,
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
    // Each window coloured on its own, so a spent model window is visible even
    // when the hour and the week are healthy.
    const five = paint(pct(fiveHourNow(a, now)).padEnd(fiveW), shadeFor(fiveHourNow(a, now)), color);
    const week = paint(pct(weekNow(a, now)).padEnd(weekW), shadeFor(weekNow(a, now)), color);
    const model = paint(
      modelText(a, now).padEnd(modelW),
      shadeFor(modelUsedNow(a, now)),
      color,
    );
    const dot = paint('●', statusColor(a, now), color);
    return `${cursor}${active} ${name}  ${email}  ${plan}  ${pri}  ${five}  ${week}  ${model}  ${dot} ${statusText(a, now)}`;
  });

  const lines = [titleLine, rule, header, ...rows, rule];

  // Everything about the highlighted account, including when each window returns.
  const highlighted = accounts[options.selected ?? 0];
  if (options.interactive && highlighted) {
    lines.push(paint(`  ${detailLine(highlighted, now)}`, codes.dim, color));
    lines.push(rule);
  }

  if (events.length > 0) {
    for (const e of events.slice(-5)) lines.push(paint(`  ${e}`, codes.dim, color));
    lines.push(rule);
  }

  // The question replaces the key hints while it is up, because those keys do
  // not apply until it is answered.
  if (options.confirm) {
    lines.push(paint(`  ${options.confirm}  [y/N]`, codes.yellow, color));
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
  } else if (options.confirm) {
    lines.push(paint('  y confirm  ·  any other key cancels', codes.dim, color));
  } else if (options.interactive) {
    lines.push(
      paint(
        'j/k move  ·  enter use  ·  f now  ·  a add  ·  n rename  ·  l sign in  ·  e enable  ·  r rotate  ·  q quit',
        codes.dim,
        color,
      ),
    );
  }

  return lines.join('\n');
}
