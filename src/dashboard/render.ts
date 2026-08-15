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
  /**
   * How many columns there are to draw in.
   *
   * The table fitted an 80-column terminal with one character to spare, which
   * is not fitting, it is luck: a longer account name or a longer wait pushed
   * it over and the whole row wrapped. The bars are the elastic part, so they
   * give up width first and the numbers, names and statuses stay whole.
   */
  width?: number;
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

/** Below this a bar says nothing useful, so the number stands on its own. */
const BAR_MIN = 4;

/** Everything in a gauge that is not the bar: a space and a padded percent. */
const GAUGE_EXTRA = 5;

/**
 * The widest bar that still lets a row fit.
 *
 * Shrinks rather than wraps, and disappears entirely rather than squeezing the
 * numbers out: a row that wraps is unreadable, whereas a row of bare
 * percentages is merely plainer.
 */
function barWidthFor(width: number | undefined, nameW: number, statusW: number): number {
  if (!width || width <= 0) return BAR;
  const fixed = 3 + nameW + 2 + 2 * 2 + 2 + statusW + GAUGE_EXTRA * 3;
  const each = Math.floor((width - fixed) / 3);
  if (each >= BAR) return BAR;
  return each >= BAR_MIN ? each : 0;
}

/** Shorten a label to fit, marking that something was cut. */
function fit(text: string, width: number): string {
  if (width <= 0) return '';
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;
}

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

/**
 * What is stopping this account right now, read from the SAME numbers the row
 * is drawing.
 *
 * The status used to come only from ccx's ledger, which records limits ccx
 * itself was refused by. So an account whose five-hour window read 100% right
 * there in its own row could still be labelled "ready", because ccx had never
 * personally been turned away from it: the usage came from the API, the status
 * came from the ledger, and the two were never compared. It also disagreed
 * with the rotation planner, which uses the numbers and would have skipped
 * that account.
 *
 * A window counts as spent at 100% while it is still open, which is exactly
 * `usableCapacity`'s rule, so the table and the planner cannot drift apart.
 */
interface Constraint {
  label: string;
  until?: number | null;
}

function constraintsOn(a: DashboardAccount, model: string | null, now: number): Constraint[] {
  const out: Constraint[] = [];
  // ccx's own record of being refused. Kept separate from the numbers because
  // it is different evidence: this one was measured by being told no.
  if (a.cappedUntil && a.cappedUntil > now) out.push({ label: 'capped', until: a.cappedUntil });

  const spent = (used: number | null | undefined, resetsAt: number | null | undefined): boolean =>
    (effectiveUtilization(used, resetsAt, now) ?? 0) >= 1;

  const u = a.usage;
  if (u) {
    // Account-wide windows stop everything, whatever model you are on.
    if (spent(u.fiveHour, u.fiveHourReset)) out.push({ label: '5h', until: u.fiveHourReset });
    if (spent(u.sevenDay, u.sevenDayReset)) out.push({ label: 'week', until: u.sevenDayReset });
    // The model this table is showing. The account may still serve others, so
    // this is named rather than reported as the account being out.
    const found = model
      ? (u.models ?? []).find((m) => m.name.toLowerCase() === model.toLowerCase())
      : undefined;
    if (found && spent(found.utilization, found.resetsAt)) {
      out.push({ label: found.name.toLowerCase(), until: found.resetsAt });
    }
  }
  return out;
}

/**
 * Plain status text for an account, most-important state first.
 *
 * `maxWidth` bounds it because the label can be a model name, which comes from
 * the API and can be any length. Unbounded it sets the column width itself and
 * pushes the whole row past the edge of the terminal. What gets shortened is
 * the LABEL, never the time: "how long until it comes back" is the reason to
 * read this at all, and a truncated wait would be worse than a truncated name.
 */
function statusText(
  a: DashboardAccount,
  now: number,
  model: string | null = null,
  maxWidth = Number.MAX_SAFE_INTEGER,
): string {
  if (!a.enabled) return 'disabled';
  if (!a.loggedIn) return 'logged out';

  const blocking = constraintsOn(a, model, now);
  if (blocking.length === 0) return 'ready';

  // The wait is until the LAST of them lifts, because until then the account
  // still cannot be used. Taking the earliest would promise a return that is
  // not coming; an unknown reset time sorts last for the same reason.
  const latest = blocking.reduce((a2, b) =>
    (b.until ?? Number.POSITIVE_INFINITY) > (a2.until ?? Number.POSITIVE_INFINITY) ? b : a2,
  );
  // Name the MODEL whenever the model is one of the things blocking, even if
  // some other window lifts later. That is the question being asked of this
  // screen: the column says Fable is at 100%, and the thing worth knowing is
  // how long until Fable can be used here again.
  const named = blocking.find((c) => c.label === model?.toLowerCase()) ?? latest;
  const when = latest.until && latest.until > now ? ` ${hhmm(latest.until, now)}` : '';
  const tail = named.label === 'capped' ? when : ` spent${when}`;
  const head = named.label === 'capped' ? 'capped' : named.label;
  return `${fit(head, Math.max(3, maxWidth - tail.length))}${tail}`;
}

/** A colored status dot: green only when the account can actually be used now. */
function statusColor(a: DashboardAccount, now: number, model: string | null = null): string {
  if (!a.enabled) return codes.dim;
  if (!a.loggedIn) return codes.red;
  return constraintsOn(a, model, now).length > 0 ? codes.yellow : codes.green;
}


/**
 * The same scale as `ccx usage`, deliberately.
 *
 * The two pages describe the same numbers, and having one call 90% "amber" and
 * the other call it green taught the operator to distrust both. One function,
 * one meaning, everywhere.
 */
const shadeFor = shadeForUsed;

/**
 * A window drawn the way the usage page draws it: bar, then the number.
 *
 * A zero-width bar is a real answer, not a failure: on a narrow terminal the
 * number alone still says everything, and it is the wrapping that would make
 * the screen unreadable.
 */
function gauge(used: number | null, color: boolean, barWidth: number): string {
  const drawn = barWidth > 0 ? `${paint(bar(used, barWidth), shadeFor(used), color)} ` : '';
  return `${drawn}${pct(used).padStart(4)}`;
}

/** Printable width of a gauge, which is what the header has to line up with. */
function gaugeWidth(barWidth: number): number {
  return barWidth > 0 ? barWidth + 1 + 4 : 4;
}

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

  const fullNameW = Math.max('ACCOUNT'.length, ...accounts.map((a) => a.name.length));
  const nameW0 = fullNameW; // before the width clamp below, for sizing the bars
  // The model column is named after the model it is showing, so the header
  // says FABLE rather than MODEL and the row underneath is just a bar.
  const modelName = columnModel(accounts, now);
  // A share of the row, not whatever the longest model name happens to be.
  const statusCap = options.width
    ? Math.max('logged out'.length, Math.floor(options.width / 3))
    : Number.MAX_SAFE_INTEGER;
  const status = (a: DashboardAccount): string => statusText(a, now, modelName, statusCap);
  const statusW = Math.max('STATUS'.length, ...accounts.map((a) => status(a).length + 2));
  // The bars give up width before anything else does.
  const barW = barWidthFor(options.width, nameW0, statusW);
  const GAUGE_W = gaugeWidth(barW);

  // A column is as wide as the wider of its heading and its contents, so the
  // two line up at every terminal width. Once the bars are gone the headings
  // shorten too, rather than pushing the row back over the edge they were just
  // shrunk to fit inside.
  // The model name comes from the API and can be any length. Padded without a
  // bound it set the column width itself, pushing the row past the terminal
  // and squeezing the account names to nothing.
  const modelLabel = fit((modelName ?? 'MODEL').toUpperCase(), GAUGE_W);
  const labels = barW > 0 ? ['5-HOUR', 'WEEK', modelLabel] : ['5H', 'WK', modelLabel];
  const colW = labels.map((l) => Math.max(GAUGE_W, l.length));


  // The NAME is elastic too, once the bars have already gone. A long account
  // name in a narrow terminal would otherwise push the row over on its own,
  // and a wrapped row is the thing all of this exists to prevent.
  const others = 3 + 2 + colW.reduce((a, b) => a + b, 0) + 4 + 2 + statusW;
  const nameW = Math.min(
    fullNameW,
    options.width ? Math.max(3, options.width - others) : fullNameW,
  );

  // Two-char gutter: selection cursor then active marker, both plain-text
  // visible so the active row is clear even without color.
  const rowWidth = Math.min(
    options.width ?? Number.MAX_SAFE_INTEGER,
    nameW + others,
  );
  const rule = paint('─'.repeat(rowWidth), codes.dim, color);
  /** What a line of free text has to fit inside: the window, not the table. */
  const maxLine = options.width ?? Number.MAX_SAFE_INTEGER;

  const title = paint('claude-auto-switch', codes.bold, color);
  const active = accounts.find((a) => a.active);
  // "prefers", not "on": the dashboard is not inside a session and cannot know
  // which model one is actually running. After a fallback the session can be on
  // Opus while the preference is still Fable, and the title would have said so
  // with confidence.
  const onModel = snapshot.model ? ` · prefers ${snapshot.model}` : '';
  const subtitle = fit(`active: ${active?.name ?? 'none'}${onModel}`, Math.max(0, maxLine - 21));
  const titleLine = `${title}   ${paint(subtitle, codes.dim, color)}`;

  const header = paint(
    `   ${fit('ACCOUNT', nameW).padEnd(nameW)}  ${labels
      .map((l, i) => l.padEnd(colW[i] as number))
      .join('  ')}  STATUS`,
    codes.dim,
    color,
  );

  const rows = accounts.map((a, i) => {
    const cursor = i === options.selected ? paint('▸', codes.cyan, color) : ' ';
    const marker = a.active ? paint('*', codes.cyan, color) : ' ';
    const shown = fit(a.name, nameW).padEnd(nameW);
    const name = a.active ? paint(shown, `${codes.bold}${codes.cyan}`, color) : shown;
    // Each window drawn on its own, so a spent model window is visible even
    // when the hour and the week are healthy. Collapsing them into one number
    // hid exactly the one that stops you.
    // Padded by VISIBLE width: a gauge carries colour codes, so padding by
    // string length would count the escape bytes and leave every coloured
    // cell short.
    const pad = (text: string, i: number): string =>
      text + ' '.repeat(Math.max(0, (colW[i] as number) - GAUGE_W));
    const five = pad(gauge(fiveHourNow(a, now), color, barW), 0);
    const week = pad(gauge(weekNow(a, now), color, barW), 1);
    const model = pad(gauge(modelUsedNow(a, modelName, now), color, barW), 2);
    const dot = paint('●', statusColor(a, now, modelName), color);
    return `${cursor}${marker} ${name}  ${five}  ${week}  ${model}  ${dot} ${status(a)}`;
  });

  const lines = [titleLine, rule, header, ...rows, rule];

  // An empty table is not an answer. Someone seeing this has just installed
  // ccx, and the screen should say what to do rather than showing a header
  // with nothing under it and leaving them to guess whether it is broken.
  if (accounts.length === 0) {
    lines.push(paint(fit('  no accounts yet. add one with:  ccx add <name>', maxLine), codes.yellow, color));
    lines.push(rule);
  }

  // What the table cannot show: where rotation will actually send this session
  // when the current account runs out. Every other tool can only report the
  // state it is in; ccx knows the policy and the numbers, so it can say what
  // happens next before it happens.
  if (snapshot.nextUp) {
    lines.push(paint(fit(`  next → ${snapshot.nextUp}`, maxLine), codes.cyan, color));
  }

  // Everything about the highlighted account, including when each window returns.
  const highlighted = accounts[options.selected ?? 0];
  if (options.interactive && highlighted) {
    lines.push(paint(fit(`  ${detailLine(highlighted, now)}`, maxLine), codes.dim, color));
    lines.push(rule);
  }

  if (events.length > 0) {
    for (const e of events.slice(-5)) lines.push(paint(fit(`  ${e}`, maxLine), codes.dim, color));
    lines.push(rule);
  }

  // The question replaces the key hints while it is up, because those keys do
  // not apply until it is answered.
  //
  // [Y/n], because Enter confirms. It always has, but the label used to say
  // [y/N], which advertises the opposite, so the one key everyone reaches for
  // looked like the key that would cancel.
  if (options.confirm) {
    lines.push(paint(fit(`  ${options.confirm}  [Y/n]`, maxLine), codes.yellow, color));
  }

  if (options.notice) {
    lines.push(paint(fit(`  ${options.notice}`, maxLine), codes.yellow, color));
  }

  // While a name is being typed, the footer explains that box instead of the
  // normal keys, because the normal keys do not apply until it is finished.
  if (options.prompt) {
    lines.push(`${fit(`  ${options.prompt.label} ${options.prompt.text}`, Math.max(0, maxLine - 1))}█`);
    if (options.prompt.error) {
      lines.push(paint(fit(`  ${options.prompt.error}`, maxLine), codes.yellow, color));
    }
    lines.push(paint(fit('  enter confirm  ·  esc cancel', maxLine), codes.dim, color));
  } else if (options.confirm) {
    // Anything else still cancels, and that is deliberate: l sits next to j and
    // k, so a stray press while moving is likely, and the next keystroke after
    // it should not sign anyone in.
    lines.push(paint(fit('  enter or y confirm  ·  any other key cancels', maxLine), codes.dim, color));
  } else if (options.interactive) {
    // The hints drop off the end rather than wrapping. The ones that survive
    // are the ones you need most, in that order, so a narrow terminal loses
    // the rarely-used keys instead of losing the shape of the screen.
    // Ordered by how badly you need them, because the tail is what gets
    // dropped. Moving and choosing come first, then LEAVING: a narrow window
    // that hid `q quit` would take away the one key someone stuck here has to
    // know. The occasional ones go last.
    const hints = [
      'j/k move',
      'enter use',
      'q quit',
      'r rotate',
      'f now',
      'a add',
      'l sign in',
      'n rename',
      'e enable',
    ];
    const shown: string[] = [];
    for (const hint of hints) {
      const next = [...shown, hint].join('  ·  ');
      if (next.length > maxLine) break;
      shown.push(hint);
    }
    lines.push(paint(shown.join('  ·  '), codes.dim, color));
  }

  return lines.join('\n');
}
