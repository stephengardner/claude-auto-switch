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
  /**
   * Where this account stands in the order rotation picks from: 1 is the
   * next pick. Absent for an account rotation would not pick (disabled,
   * signed out, capped).
   */
  pick?: {
    rank: number;
    /** Work it can do before a window stops it, in full 5-hour windows (0..1). */
    runway: number;
    /** Which window binds. */
    binding: '5-hour' | 'weekly' | 'model' | 'none';
    /** Present when its week is nearly spent, so it waits behind healthier accounts. */
    heldBack?: { weekLeft: number };
  };
}

/** The rotation settings the dashboard shows and changes, already in words. */
export interface DashboardSettings {
  /** The model preference, e.g. "Opus, then Fable". */
  model: string;
  /** The pick rule, e.g. "longest run first". */
  order: string;
  /** How full a week holds an account back, e.g. "weeks 80%+ used"; absent when off. */
  holdBack?: string;
}

/** A ccx session running now, numbered the way the dashboard asks about them. */
export interface DashboardSession {
  number: number;
  /** Its folder's name, or the pid when its folder is unknown. */
  where: string;
  account: string;
}

/** One row of the settings panel, already in words. */
export interface PanelRow {
  group: string;
  label: string;
  value: string;
}

/** The settings panel, while it is open in place of the accounts. */
export interface SettingsPanel {
  rows: PanelRow[];
  selected: number;
  /** What the highlighted setting does. */
  help: string;
  /** When a change to it takes effect. */
  applies: string;
}

export interface DashboardSnapshot {
  accounts: DashboardAccount[];
  /** Recent activity lines, oldest first. */
  events: string[];
  now: number;
  refreshMs: number;
  /** The model in use, when anything pins one. Shown beside the active account. */
  model?: string;
  /** Which ccx is drawing this, shown in the title. */
  version?: string;
  /**
   * Where rotation would go next, already in words.
   *
   * Computed by the caller, which has the policy and the ledger, so this
   * renderer stays a pure function of what it is given. It is the one thing on
   * this screen that no other tool can show: not the state, but the
   * consequence of it.
   */
  nextUp?: string;
  /**
   * Claude Desktop, when it is in use here: which account it spends and its
   * open conversations (`line`), and the keys that act on it (`keys`).
   */
  desktop?: { line: string; keys: string };
  /** The rotation settings, shown with the keys that change them. */
  settings?: DashboardSettings;
  /** The ccx sessions running now, and the account each is on. */
  sessions?: DashboardSession[];
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
  /** The settings panel, drawn instead of the accounts while it is open. */
  panel?: SettingsPanel;
  /**
   * How many rows there are to draw in. The settings panel scrolls to keep the
   * highlighted setting on screen rather than grow past the bottom, where a
   * frame repainted from the top would tear.
   */
  height?: number;
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
import { accountStatus } from './account-status.js';

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

/** The pick-order cell before each name: two digits and a space. */
const RANK_W = 3;

/** Runway in words: how much of a 5-hour window, and which window binds. */
function runwayWords(pick: NonNullable<DashboardAccount['pick']>): string {
  const share = pick.runway >= 0.995 ? 'a full 5-hour window' : `${Math.round(pick.runway * 100)}% of a 5-hour window`;
  const binds = pick.binding === 'weekly' ? ' (the week binds)' : pick.binding === 'model' ? ' (the model binds)' : '';
  return `room for ${share}${binds}`;
}

/**
 * The account's place in the pick order, with why it is held back when it is.
 * Said beside the number rather than after the room, where a long line cut it
 * off: it is the answer to "why is this one so far down".
 */
function pickWords(pick: NonNullable<DashboardAccount['pick']>): string {
  const held = pick.heldBack ? ` (held back: ${Math.round(pick.heldBack.weekLeft * 100)}% of its week left)` : '';
  return `pick #${pick.rank}${held}, ${runwayWords(pick)}`;
}

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
  const fixed = 3 + RANK_W + nameW + 2 + 2 * 2 + 2 + statusW + GAUGE_EXTRA * 3;
  const each = Math.floor((width - fixed) / 3);
  if (each >= BAR) return BAR;
  return each >= BAR_MIN ? each : 0;
}

/** Shorten a label to fit, marking that something was cut. */
function fit(text: string, width: number): string {
  if (width <= 0) return '';
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;
}

/** Text broken into lines of at most `width`, at spaces; a word too long for one is cut. */
function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line !== '' && line.length + 1 + word.length > width) {
      lines.push(line);
      line = '';
    }
    line = line === '' ? fit(word, width) : `${line} ${word}`;
  }
  if (line !== '') lines.push(line);
  return lines;
}

/**
 * Shorten text being typed from the FRONT, so the end, where the typing is,
 * stays in view. Cutting the end, as fit does, hid every character typed past
 * the edge of the screen.
 */
function fitTail(head: string, text: string, width: number): string {
  if (head.length + text.length <= width) return head + text;
  const room = width - head.length - 1;
  return room > 0 ? `${head}…${text.slice(text.length - room)}` : fit(head + text, width);
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
 * The status as a line of text, from the shared rule.
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
  const status = accountStatus(a, model, now);
  if (status.state === 'disabled') return 'disabled';
  if (status.state === 'logged-out') return 'logged out';
  if (status.state === 'ready') return 'ready';

  const when = status.until ? ` ${hhmm(status.until, now)}` : '';
  const capped = status.label === 'capped';
  const tail = capped ? when : ` spent${when}`;
  const head = capped ? 'capped' : (status.label as string);
  return `${fit(head, Math.max(3, maxWidth - tail.length))}${tail}`;
}

/** A colored status dot: green only when the account can actually be used now. */
function statusColor(a: DashboardAccount, now: number, model: string | null = null): string {
  const state = accountStatus(a, model, now).state;
  if (state === 'disabled') return codes.dim;
  if (state === 'logged-out') return codes.red;
  return state === 'blocked' ? codes.yellow : codes.green;
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
  const picked = a.pick ? [pickWords(a.pick)] : [];
  const parts = [
    ...picked,
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
  if (options.panel) return renderPanel(snapshot, options.panel, options);
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
  const others = 3 + RANK_W + 2 + colW.reduce((a, b) => a + b, 0) + 4 + 2 + statusW;
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

  // The build is on screen, not just in the log. A report of "it did X" has to
  // be tied to the code that did X, and the live view is where someone is
  // looking when they notice the X.
  const named = snapshot.version ? `claude-auto-switch ${snapshot.version}` : 'claude-auto-switch';
  // Measured, not assumed to be a fixed 21 columns. The version made the title
  // longer, and a hard-coded width would have let a narrow terminal wrap the
  // one line that says what this screen is.
  const shownTitle = fit(named, maxLine);
  const title = paint(shownTitle, codes.bold, color);
  const active = accounts.find((a) => a.active);
  // "prefers", not "on": the dashboard is not inside a session and cannot know
  // which model one is actually running. After a fallback the session can be on
  // Opus while the preference is still Fable, and the title would have said so
  // with confidence.
  const onModel = snapshot.model ? ` · prefers ${snapshot.model}` : '';
  const subtitle = fit(
    `active: ${active?.name ?? 'none'}${onModel}`,
    Math.max(0, maxLine - shownTitle.length - 3),
  );
  const titleLine = `${title}   ${paint(subtitle, codes.dim, color)}`;

  const header = paint(
    `   ${'#'.padStart(RANK_W - 1)} ${fit('ACCOUNT', nameW).padEnd(nameW)}  ${labels
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
    // Where rotation would pick it, 1 being next; a dot when it would not.
    const rankText = (a.pick ? String(a.pick.rank) : '·').padStart(RANK_W - 1);
    const rank = paint(rankText, a.pick?.rank === 1 ? codes.cyan : codes.dim, color);
    return `${cursor}${marker} ${rank} ${name}  ${five}  ${week}  ${model}  ${dot} ${status(a)}`;
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

  // The settings rotation runs on, with the keys that change them, so they can
  // be seen and changed here rather than looked up.
  if (snapshot.settings) {
    const held = snapshot.settings.holdBack ? `  ·  held back: ${snapshot.settings.holdBack}` : '';
    const now = `model: ${snapshot.settings.model}  ·  pick: ${snapshot.settings.order}${held}`;
    if (options.interactive) {
      // Led by the key that opens every setting, in bright, where a narrow
      // terminal cannot cut it off: at the end of the line, in grey like the
      // rest, it was there and nobody saw it. (M and o still change the model
      // and the pick rule from here.)
      const line = fit(`  s settings  ·  ${now}`, maxLine);
      lines.push(
        line.length > 3 ? `  ${paint('s', codes.bold, color)}${paint(line.slice(3), codes.dim, color)}` : line,
      );
    } else {
      lines.push(paint(fit(`  ${now}`, maxLine), codes.dim, color));
    }
  }

  // Which session is on which account, numbered the way Enter and f ask
  // about them when more than one is running.
  if (snapshot.sessions && snapshot.sessions.length > 0) {
    const each = snapshot.sessions.map((s) => `${s.number} ${s.where} on ${s.account}`).join('  ·  ');
    lines.push(paint(fit(`  sessions: ${each}`, maxLine), codes.dim, color));
  }

  // Claude Desktop runs on its own account, which ccx cannot switch, so it gets
  // a line of its own: what it is spending, and the keys that move its
  // conversations somewhere ccx can.
  if (snapshot.desktop) {
    lines.push(paint(fit(`  ${snapshot.desktop.line}`, maxLine), codes.magenta, color));
    if (options.interactive) {
      lines.push(paint(fit(`    ${snapshot.desktop.keys}`, maxLine), codes.dim, color));
    }
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

  lines.push(...footer(options, maxLine, color, MAIN_HINTS));
  return lines.join('\n');
}

/**
 * The account list's key hints. They drop off the end rather than wrapping, so
 * they are ordered by how badly you need them: a narrow terminal loses the
 * rarely-used keys instead of losing the shape of the screen. LEAVING comes
 * first: a narrow window that hid the quit hint would take away the one key
 * someone stuck here has to know, and every other key can be found by trying.
 * It used to sit third, which was fine while it read `q quit`; naming esc as
 * well made it four columns longer and moved it closer to falling off the end,
 * so it is no longer allowed to be the one that drops. Settings comes early:
 * it is where everything else that can be changed lives.
 */
const MAIN_HINTS: ReadonlyArray<readonly [string, string]> = [
  ['q/esc', 'quit'],
  ['j/k', 'move'],
  ['enter', 'use'],
  ['s', 'settings'],
  ['r', 'rotate'],
  ['f', 'now'],
  ['a', 'add'],
  ['l', 'sign in'],
  ['n', 'rename'],
  ['e', 'enable'],
  ['[ ]', 'order'],
];

/** The settings panel's key hints, in the same order of need. */
const PANEL_HINTS: ReadonlyArray<readonly [string, string]> = [
  ['s/esc', 'back'],
  ['j/k', 'move'],
  ['←/→', 'change'],
  ['enter', 'edit'],
  ['d', 'default'],
  ['q', 'quit'],
];

/**
 * A row of key hints that fits, the key bright and what it does dim: in a line
 * that is mostly words, the keys are what the eye looks for. All dim, the one
 * key that opens every setting read as one more grey word.
 */
function hintLine(hints: ReadonlyArray<readonly [string, string]>, maxLine: number, color: boolean): string {
  const shown: Array<readonly [string, string]> = [];
  for (const hint of hints) {
    const next = [...shown, hint].map(([key, does]) => `${key} ${does}`).join('  ·  ');
    if (next.length > maxLine) break;
    shown.push(hint);
  }
  return shown
    .map(([key, does]) => `${paint(key, codes.bold, color)}${paint(` ${does}`, codes.dim, color)}`)
    .join(paint('  ·  ', codes.dim, color));
}

/**
 * The bottom of the screen, shared by the accounts and the settings panel: a
 * question, a notice, the box being typed in, or the key hints.
 */
function footer(
  options: RenderOptions,
  maxLine: number,
  color: boolean,
  hints: ReadonlyArray<readonly [string, string]>,
): string[] {
  const lines: string[] = [];
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
    const head = `  ${options.prompt.label} `;
    if (head.length > maxLine / 2) {
      // A long question (which sessions to move) gets lines of its own, so
      // the box under it keeps the whole width for what is typed.
      for (const line of wrap(options.prompt.label, maxLine - 2)) lines.push(`  ${line}`);
      lines.push(`${fitTail('  › ', options.prompt.text, Math.max(0, maxLine - 1))}█`);
    } else {
      lines.push(`${fitTail(head, options.prompt.text, Math.max(0, maxLine - 1))}█`);
    }
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
    lines.push(hintLine(hints, maxLine, color));
  }
  return lines;
}

/**
 * The settings panel: every setting under its group, the highlighted one
 * explained underneath, drawn in place of the accounts.
 *
 * Scrolls rather than grows. The dashboard repaints from the top of the
 * screen, and a frame taller than the terminal pushes its own top off, so the
 * list keeps to the rows there are and moves to keep the highlighted setting
 * in view.
 */
function renderPanel(snapshot: DashboardSnapshot, panel: SettingsPanel, options: RenderOptions): string {
  const color = options.color ?? true;
  const maxLine = options.width ?? Number.MAX_SAFE_INTEGER;
  const rule = paint('─'.repeat(Math.min(maxLine, 100)), codes.dim, color);
  const named = snapshot.version ? `claude-auto-switch ${snapshot.version}` : 'claude-auto-switch';
  const title = `${paint(fit(named, maxLine), codes.bold, color)}   ${paint(fit('settings', Math.max(0, maxLine - named.length - 3)), codes.dim, color)}`;

  // The labels give up width only on a terminal too narrow for them and a
  // few characters of value, so a row never runs past the edge.
  const labelW = Math.max(4, Math.min(Math.max(...panel.rows.map((r) => r.label.length), 0), maxLine - 14));
  const list: Array<{ text: string; row: number | null }> = [];
  let group = '';
  panel.rows.forEach((r, i) => {
    if (r.group !== group) {
      group = r.group;
      list.push({ text: paint(fit(`  ${r.group}`, maxLine), codes.bold, color), row: null });
    }
    const chosen = i === panel.selected;
    const cursor = chosen ? paint('▸', codes.cyan, color) : ' ';
    // The value gets what the row has left, counted in visible columns: the
    // cursor carries colour codes, which take no room on screen.
    const value = fit(r.value, Math.max(0, maxLine - (labelW + 8)));
    list.push({
      text: `   ${cursor} ${fit(r.label, labelW).padEnd(labelW)}   ${chosen ? paint(value, codes.cyan, color) : value}`,
      row: i,
    });
  });

  const bottom = footer(options, maxLine, color, PANEL_HINTS);
  // The explanation is the point of the panel, so it wraps (to three lines at
  // most) rather than being cut off mid-sentence like the table's lines.
  const explained = [
    ...wrap(panel.help, Math.max(1, maxLine - 2))
      .slice(0, 3)
      .map((l) => paint(`  ${l}`, codes.dim, color)),
    paint(fit(`  ${panel.applies}`, maxLine), codes.dim, color),
  ];
  // Title, two rules, the explanation and the footer are always shown; the
  // list gets what is left, and at least a few rows.
  const fixed = 3 + explained.length + bottom.length;
  const room = options.height ? Math.max(4, options.height - fixed - 1) : list.length;
  let shown = list;
  if (list.length > room) {
    // Centred on the highlighted setting, and never past either end.
    const at = Math.max(0, list.findIndex((l) => l.row === panel.selected));
    const from = Math.min(Math.max(0, at - Math.floor(room / 2)), list.length - room);
    shown = list.slice(from, from + room);
  }

  return [title, rule, ...shown.map((l) => l.text), rule, ...explained, ...bottom].join('\n');
}
