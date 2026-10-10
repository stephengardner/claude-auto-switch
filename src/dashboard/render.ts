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
   * Subscription usage (0..1 USED per window), including per-model weekly
   * windows and when each window resets. The screen shows what is left.
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
   * Where rotation would go next, in the words `ccx state` hands to other
   * programs. Carried for them; the screen draws `whenOut`.
   */
  nextUp?: string;
  /**
   * The same move in the screen's words: what follows "when one runs out",
   * and the account it names, which the table marks as next in line.
   *
   * Computed by the caller, which has the policy and the ledger, so this
   * renderer stays a pure function of what it is given. It is the one thing on
   * this screen that no other tool can show: not the state, but the
   * consequence of it.
   */
  whenOut?: { account?: string; words: string };
  /**
   * Claude Desktop, when it is in use here: which account it spends and its
   * open conversations (`line`), and the keys that act on it (`keys`).
   */
  desktop?: { line: string; keys: string };
  /** The rotation settings, shown with the keys that change them. */
  settings?: DashboardSettings;
  /** The ccx sessions running now, and the account each is on. Counted per account. */
  sessions?: DashboardSession[];
}

export interface RenderOptions {
  color?: boolean;
  /** Interactive key hints in the footer (off for a plain one-shot print). */
  interactive?: boolean;
  /**
   * Index of the currently-selected row (for the live cursor), counted in the
   * order the rows are drawn, which `inDisplayOrder` gives.
   */
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
   * How many columns there are to draw in. A row never wraps: the table gives
   * things up to fit, in the order `table.ts` sets out.
   */
  width?: number;
  /**
   * A time of day in words, shown beside a wait of under a day. The local
   * 12-hour clock unless a test passes its own.
   */
  clock?: (epochMs: number) => string;
}

import { codes, paint } from '../ui/style.js';
import { effectiveUtilization } from '../usage/window-open.js';
import { normalizeModel } from '../usage/model-preference.js';
import { arrange, type Block } from './arrange.js';
import { plainRecent } from './recent.js';
import { clockTime, drawTable, fit, hhmm } from './table.js';

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

/** What the title calls this program, with the build drawing it. */
function titled(version: string | undefined): string {
  return version ? `ccx ${version}` : 'ccx';
}

/** The heading each block after the first is drawn under. */
const BLOCK_HEADING: Record<Block, string | null> = {
  usable: null,
  out: 'out of room',
  off: 'not in rotation',
};

/**
 * What the table has no column for about the highlighted account: who it is,
 * why it stands where it does in the pick order, and each of its per-model
 * windows. The 5-hour and week windows are in its row.
 */
function detailLine(a: DashboardAccount, now: number): string {
  const who = [a.email, a.plan, `priority ${a.priority}`].filter(Boolean).join(' · ');
  const heading = `${a.name} (${who})`;
  const u = a.usage;
  if (!u) return `${heading}: no usage read yet`;
  const parts = a.pick ? [pickWords(a.pick)] : [];
  for (const m of u.models ?? []) {
    const used = effectiveUtilization(m.utilization, m.resetsAt, now);
    const left = used === null ? '?' : `${Math.round(Math.max(0, 1 - used) * 100)}%`;
    const resets = typeof m.resetsAt === 'number' && m.resetsAt > now ? `, resets in ${hhmm(m.resetsAt, now)}` : '';
    parts.push(`${m.name} ${left} left${resets}`);
  }
  return parts.length > 0 ? `${heading}: ${parts.join('   ')}` : heading;
}

/** Render the full dashboard frame for the given snapshot. */
export function renderDashboard(snapshot: DashboardSnapshot, options: RenderOptions = {}): string {
  if (options.panel) return renderPanel(snapshot, options.panel, options);
  const color = options.color ?? true;
  const { now } = snapshot;
  /** What a line of free text has to fit inside: the window, not the table. */
  const maxLine = options.width && options.width > 0 ? options.width : Number.MAX_SAFE_INTEGER;
  const placed = arrange(snapshot.accounts, snapshot.model ?? null, now);

  const sessions = new Map<string, number>();
  for (const s of snapshot.sessions ?? []) sessions.set(s.account, (sessions.get(s.account) ?? 0) + 1);
  // The account the line under the table names, so the two cannot point at
  // different rows. With no such line, the first pick.
  const next = snapshot.whenOut
    ? snapshot.whenOut.account
    : placed.find((p) => p.account.pick?.rank === 1)?.account.name;
  const table = drawTable(
    { placed, now, model: snapshot.model ?? null, sessions, next },
    {
      color,
      clock: options.clock ?? clockTime,
      ...(options.width ? { width: options.width } : {}),
      ...(options.selected !== undefined ? { selected: options.selected } : {}),
    },
  );

  // The build is on screen, not just in the log. A report of "it did X" has to
  // be tied to the code that did X, and the live view is where someone is
  // looking when they notice the X.
  const named = fit(titled(snapshot.version), maxLine);
  const active = snapshot.accounts.find((a) => a.active);
  // "first", not "on": the dashboard is not inside a session and cannot know
  // which model one is actually running. After a fallback a session can be on
  // Opus while the preference still puts Fable first.
  const model = snapshot.model ? normalizeModel(snapshot.model) : '';
  const first = model ? ` · ${model.charAt(0).toUpperCase()}${model.slice(1)} first` : '';
  const starts = active ? `new sessions start on ${active.name}` : 'no account chosen for new sessions';
  // The frame is as wide as the table, or the title when that is wider, and
  // the right-hand side of the title ends where the rules do.
  const frameW = Math.min(maxLine, Math.max(table.width, named.length + 3 + starts.length + first.length));
  const room = Math.max(0, frameW - named.length - 3);
  const subtitle = (starts + first).length <= room ? starts + first : fit(starts, room);
  const title = paint(named, codes.bold, color);
  const titleLine =
    subtitle === ''
      ? title
      : `${title}${' '.repeat(frameW - named.length - subtitle.length)}${paint(subtitle, codes.dim, color)}`;
  const rule = paint('─'.repeat(frameW), codes.dim, color);

  const lines = [titleLine, rule];
  if (placed.length === 0) {
    // An empty table is not an answer. Someone seeing this has just installed
    // ccx, and the screen should say what to do rather than showing a header
    // with nothing under it and leaving them to guess whether it is broken.
    lines.push(paint(fit(' no accounts yet. add one with:  ccx add <name>', maxLine), codes.yellow, color));
  } else {
    lines.push(table.header);
    let block: Block = 'usable';
    for (const row of table.rows) {
      const heading = row.block === block ? null : BLOCK_HEADING[row.block];
      block = row.block;
      if (heading) {
        const lead = fit(`── ${heading} `, frameW);
        lines.push(paint(`${lead}${'─'.repeat(Math.max(0, frameW - lead.length))}`, codes.dim, color));
      }
      lines.push(row.line);
    }
  }
  lines.push(rule);

  // What the table cannot show: where a session goes when its account runs
  // out. Every other tool can only report the state it is in; ccx knows the
  // policy and the numbers, so it can say what happens next before it happens.
  if (snapshot.whenOut) {
    lines.push(paint(fit(` when one runs out → ${snapshot.whenOut.words}`, maxLine), codes.cyan, color));
  }

  // The settings rotation runs on, with the keys that change them, so they can
  // be seen and changed here rather than looked up.
  if (snapshot.settings) {
    const held = snapshot.settings.holdBack ? `  ·  held back: ${snapshot.settings.holdBack}` : '';
    const values = `model: ${snapshot.settings.model}  ·  pick: ${snapshot.settings.order}${held}`;
    if (options.interactive) {
      // Led by the key that opens every setting, in bright, where a narrow
      // terminal cannot cut it off: at the end of the line, in grey like the
      // rest, it was there and nobody saw it. (M and o still change the model
      // and the pick rule from here.)
      const line = fit(` s settings  ·  ${values}`, maxLine);
      lines.push(
        line.length > 2 ? ` ${paint('s', codes.bold, color)}${paint(line.slice(2), codes.dim, color)}` : line,
      );
    } else {
      lines.push(paint(fit(` ${values}`, maxLine), codes.dim, color));
    }
  }

  // A session keeps running on an account that was removed until it next
  // moves. It has no row to be counted in, so it is said here.
  const listed = new Set(snapshot.accounts.map((a) => a.name));
  const stray = [...sessions].filter(([name]) => !listed.has(name));
  if (stray.length > 0) {
    const count = stray.reduce((n, [, running]) => n + running, 0);
    const where = stray.length === 1 ? 'an account' : 'accounts';
    lines.push(
      paint(
        fit(
          ` ${count} session${count === 1 ? '' : 's'} on ${where} no longer here: ${stray.map(([name]) => name).join(', ')}`,
          maxLine,
        ),
        codes.yellow,
        color,
      ),
    );
  }

  // Claude Desktop runs on its own account, which ccx cannot switch, so it gets
  // a line of its own: what it is spending, and the keys that move its
  // conversations somewhere ccx can.
  if (snapshot.desktop) {
    lines.push(paint(fit(` ${snapshot.desktop.line}`, maxLine), codes.magenta, color));
    if (options.interactive) {
      lines.push(paint(fit(`   ${snapshot.desktop.keys}`, maxLine), codes.dim, color));
    }
  }

  const highlighted = placed[options.selected ?? 0]?.account;
  if (options.interactive && highlighted) {
    lines.push(paint(fit(` ${detailLine(highlighted, now)}`, maxLine), codes.dim, color));
  }

  plainRecent(snapshot.events).forEach((event, i) => {
    lines.push(paint(fit(`${i === 0 ? ' recent  ' : '         '}${event}`, maxLine), codes.dim, color));
  });

  const bottom = footer(options, maxLine, color, MAIN_HINTS);
  if (bottom.length > 0) lines.push(rule, ...bottom);
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
  ['x', 'remove'],
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
  const named = titled(snapshot.version);
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
