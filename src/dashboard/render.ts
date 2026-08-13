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
  /** The model in use, when anything pins one. Shown beside the active account. */
  model?: string;
  /**
   * Where rotation would go next, already in words.
   *
   * Computed by the caller, which has the policy and the ledger, so this
   * renderer stays a pure function of what it is given. It is the one thing on
   * this screen that no other tool can show: not the state, but the
   * consequence of it.
   */
  nextUp?: string;
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

import { codes, paint, shadeForUsed } from '../ui/style.js';
import { bar } from '../usage/report.js';
import { effectiveUtilization, bindsHarder } from '../usage/window-open.js';

/**
 * How wide each window's bar is drawn.
 *
 * Short on purpose: this table carries three of them per row plus a status,
 * and the bar is here to be read at a glance rather than measured. The precise
 * number is printed beside it for anyone who wants it.
 */
const BAR = 10;

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


/**
 * The same scale as `ccx usage`, deliberately.
 *
 * The two pages describe the same numbers, and having one call 90% "amber" and
 * the other call it green taught the operator to distrust both. One function,
 * one meaning, everywhere.
 */
const shadeFor = shadeForUsed;

/** A window drawn the way the usage page draws it: bar, then the number. */
function gauge(used: number | null, color: boolean): string {
  return `${paint(bar(used, BAR), shadeFor(used), color)} ${pct(used).padStart(4)}`;
}

/** Printable width of a gauge, which is what the header has to line up with. */
const GAUGE_W = BAR + 1 + 4;

/**
 * A window's utilization as a whole percent, or `?` when nobody has read it.
 *
 * `?` and not `0%`, and not a blank: zero would claim the account is entirely
 * free when the truth is that it has not been measured, and a blank reads as a
 * rendering fault. The usage page says `?` for the same thing, so the two
 * pages answer "unknown" the same way.
 */
function pct(used: number | null | undefined): string {
  return typeof used === 'number' ? `${Math.round(used * 100)}%` : '?';
}

/**
 * Which model the model column is about.
 *
 * ONE model for the whole column, chosen as the one that binds hardest across
 * the accounts. Naming the column after each account's own worst model was
 * worse than naming it "MODEL": the header said FABLE while a row underneath
 * showed that account's Opus number, so the table quietly compared two
 * different things and looked like it was comparing one.
 */
function columnModel(accounts: DashboardAccount[], now: number): string | null {
  let best: { name: string; utilization: number; resetsAt?: number | null } | null = null;
  for (const a of accounts) {
    for (const m of a.usage?.models ?? []) {
      if (typeof m.utilization !== 'number') continue;
      const measured = (x: { utilization: number; resetsAt?: number | null }) => ({
        used: x.utilization,
        resetsAt: x.resetsAt,
      });
      if (best === null || bindsHarder(measured(m), measured(best), now)) best = m;
    }
  }
  return best?.name ?? null;
}

/** THAT model's usage for this account, or null when it has no such window. */
function modelUsedNow(a: DashboardAccount, name: string | null, now: number): number | null {
  if (!name) return null;
  const key = name.toLowerCase();
  const found = (a.usage?.models ?? []).find((m) => m.name.toLowerCase() === key);
  return found ? effectiveUtilization(found.utilization, found.resetsAt, now) : null;
}

/** The account-wide numbers as they stand now, so a reset window reads empty. */
function fiveHourNow(a: DashboardAccount, now: number): number | null {
  return effectiveUtilization(a.usage?.fiveHour, a.usage?.fiveHourReset, now);
}
function weekNow(a: DashboardAccount, now: number): number | null {
  return effectiveUtilization(a.usage?.sevenDay, a.usage?.sevenDayReset, now);
}

/**
 * Everything known about the highlighted account, on one line: each window, what
 * it is at, and when it comes back. The table gives the numbers at a glance; this
 * answers "and when can I use it again" without a second command.
 */
function detailLine(a: DashboardAccount, now: number): string {
  // Who this account IS, which the table no longer has room to say. The bars
  // took the width the email and plan columns used to hold, and those are
  // worth more here anyway: one account at a time, where you are looking.
  const who = [a.email, a.plan, `priority ${a.priority}`].filter(Boolean).join(' · ');
  const heading = who ? `${a.name} (${who})` : a.name;
  const u = a.usage;
  if (!u) return `${heading}: no usage read yet`;
  const parts = [
    `5h ${pct(effectiveUtilization(u.fiveHour, u.fiveHourReset, now))}${resetSuffix(u.fiveHourReset, now)}`,
    `week ${pct(effectiveUtilization(u.sevenDay, u.sevenDayReset, now))}${resetSuffix(u.sevenDayReset, now)}`,
  ];
  for (const m of u.models ?? []) {
    parts.push(
      `${m.name} ${pct(effectiveUtilization(m.utilization, m.resetsAt, now))}${resetSuffix(m.resetsAt, now)}`,
    );
  }
  return `${heading}: ${parts.join('   ')}`;
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
  // The model column is named after the model it is showing, so the header
  // says FABLE rather than MODEL and the row underneath is just a bar.
  const modelName = columnModel(accounts, now);
  const statusW = Math.max('STATUS'.length, ...accounts.map((a) => statusText(a, now).length + 2));

  // Two-char gutter: selection cursor then active marker, both plain-text
  // visible so the active row is clear even without color.
  const rowWidth = 3 + nameW + 2 + GAUGE_W * 3 + 4 + 2 + statusW;
  const rule = paint('─'.repeat(rowWidth), codes.dim, color);

  const title = paint('claude-auto-switch', codes.bold, color);
  const active = accounts.find((a) => a.active);
  const onModel = snapshot.model ? ` · on ${snapshot.model}` : '';
  const titleLine = `${title}   ${paint(`active: ${active?.name ?? 'none'}${onModel}`, codes.dim, color)}`;

  const header = paint(
    `   ${'ACCOUNT'.padEnd(nameW)}  ${'5-HOUR'.padEnd(GAUGE_W)}  ${'WEEK'.padEnd(GAUGE_W)}  ${(modelName ?? 'MODEL').toUpperCase().padEnd(GAUGE_W)}  STATUS`,
    codes.dim,
    color,
  );

  const rows = accounts.map((a, i) => {
    const cursor = i === options.selected ? paint('▸', codes.cyan, color) : ' ';
    const marker = a.active ? paint('*', codes.cyan, color) : ' ';
    const name = a.active
      ? paint(a.name.padEnd(nameW), `${codes.bold}${codes.cyan}`, color)
      : a.name.padEnd(nameW);
    // Each window drawn on its own, so a spent model window is visible even
    // when the hour and the week are healthy. Collapsing them into one number
    // hid exactly the one that stops you.
    const five = gauge(fiveHourNow(a, now), color);
    const week = gauge(weekNow(a, now), color);
    const model = gauge(modelUsedNow(a, modelName, now), color);
    const dot = paint('●', statusColor(a, now), color);
    return `${cursor}${marker} ${name}  ${five}  ${week}  ${model}  ${dot} ${statusText(a, now)}`;
  });

  const lines = [titleLine, rule, header, ...rows, rule];

  // An empty table is not an answer. Someone seeing this has just installed
  // ccx, and the screen should say what to do rather than showing a header
  // with nothing under it and leaving them to guess whether it is broken.
  if (accounts.length === 0) {
    lines.push(paint('  no accounts yet. add one with:  ccx add <name>', codes.yellow, color));
    lines.push(rule);
  }

  // What the table cannot show: where rotation will actually send this session
  // when the current account runs out. Every other tool can only report the
  // state it is in; ccx knows the policy and the numbers, so it can say what
  // happens next before it happens.
  if (snapshot.nextUp) {
    lines.push(paint(`  next → ${snapshot.nextUp}`, codes.cyan, color));
  }

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
  //
  // [Y/n], because Enter confirms. It always has, but the label used to say
  // [y/N], which advertises the opposite, so the one key everyone reaches for
  // looked like the key that would cancel.
  if (options.confirm) {
    lines.push(paint(`  ${options.confirm}  [Y/n]`, codes.yellow, color));
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
    // Anything else still cancels, and that is deliberate: l sits next to j and
    // k, so a stray press while moving is likely, and the next keystroke after
    // it should not sign anyone in.
    lines.push(paint('  enter or y confirm  ·  any other key cancels', codes.dim, color));
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
