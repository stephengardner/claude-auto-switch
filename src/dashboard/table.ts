import { codes, paint, shadeForUsed } from '../ui/style.js';
import { bar } from '../usage/report.js';
import { bindsHarder, effectiveUtilization } from '../usage/window-open.js';
import { normalizeModel } from '../usage/model-preference.js';
import type { Block, Placed } from './arrange.js';
import type { DashboardAccount } from './render.js';

/**
 * The accounts table of the dashboard: one row per account, a bar and a
 * number for what is left of each window, and when that window resets beside
 * it. Pure, like the renderer that frames it.
 *
 * Every column is as wide as its widest cell in the frame, so a bar starts at
 * the same column on every row whatever the names and reset texts are.
 */

/** A stretch of text in one colour. A cell, and a row, is a few of them. */
interface Run {
  text: string;
  code?: string;
}

const visible = (runs: readonly Run[]): number => runs.reduce((n, r) => n + r.text.length, 0);
const gap = (width: number): Run => ({ text: ' '.repeat(Math.max(0, width)) });
const draw = (runs: readonly Run[], color: boolean): string =>
  runs.map((r) => (r.code && r.text.trim() !== '' ? paint(r.text, r.code, color) : r.text)).join('');

/** Without the blank cells a row ends in, which would only be trailing spaces. */
function trimmed(runs: readonly Run[]): Run[] {
  const out = [...runs];
  while (out.length > 0 && out[out.length - 1]?.text.trim() === '') out.pop();
  return out;
}

/** The runs cut to `width` columns, whatever colour each is in. */
function clip(runs: readonly Run[], width: number): Run[] {
  const out: Run[] = [];
  let room = width;
  for (const run of runs) {
    if (room <= 0) break;
    out.push(run.text.length <= room ? run : { ...run, text: run.text.slice(0, room) });
    room -= run.text.length;
  }
  return out;
}

/** Shorten a label to fit, marking that something was cut. */
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;
}

/**
 * A wait, at the coarsest useful precision: minutes within the hour, hours
 * within the day, then days. Weekly windows are days away, and printing those as
 * "72h0m" is technically right and useless to read.
 */
export function hhmm(epochMs: number, now: number): string {
  const mins = Math.max(0, Math.round((epochMs - now) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

/** A time of day as a 12-hour clock reads it, in the local zone: "3:15 AM". */
export function clockTime(epochMs: number): string {
  const at = new Date(epochMs);
  const hour = at.getHours();
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(at.getMinutes()).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** How wide a bar is drawn when there is room, and below what it is not worth drawing. */
const BAR = 10;
const BAR_MIN = 4;
/** A name is never cut shorter than this. */
const NAME_MIN = 3;
const DAY_MS = 24 * 60 * 60_000;

/**
 * What a frame is drawn with. A narrow terminal gives these up one at a time,
 * in the order of LADDER, and a row never wraps.
 */
interface Shape {
  /** The time of day beside a wait of under a day: "resets in 4h 16m (3:15 AM)". */
  clocks: boolean;
  /** "resets in 4h 16m" and "next in line" in full, or "4h 16m" and "next". */
  words: boolean;
  /** Cells in each bar; 0 draws none. */
  bar: number;
  notes: boolean;
  resets: boolean;
}

/**
 * The order things are given up in: clock times, then the bars (narrower,
 * then gone), then the words "resets in" (the time stays), then the notes at
 * the end of each row, then the reset times. Names are shortened only after
 * all of that, because accounts are often named alike up to their last few
 * characters.
 */
const LADDER: readonly Shape[] = [
  { clocks: true, words: true, bar: BAR, notes: true, resets: true },
  ...Array.from({ length: BAR - BAR_MIN + 1 }, (_, i) => ({
    clocks: false,
    words: true,
    bar: BAR - i,
    notes: true,
    resets: true,
  })),
  { clocks: false, words: true, bar: 0, notes: true, resets: true },
  { clocks: false, words: false, bar: 0, notes: true, resets: true },
  { clocks: false, words: false, bar: 0, notes: false, resets: true },
  { clocks: false, words: false, bar: 0, notes: false, resets: false },
];

/** One window of one account, as its cell shows it. */
interface WindowView {
  /** Used now, 0 to 1; null when it has not been read. */
  used: number | null;
  /** When it resets, while one is running; null when none is. */
  resetsAt: number | null;
  /** This is the cell that says when the account is back. */
  back: boolean;
}

/** Something said at the end of a row. */
interface Note {
  text: string;
  /** What it shortens to once the frame has given up its words. */
  short?: string;
  code?: string;
}

interface Row {
  placed: Placed;
  selected: boolean;
  next: boolean;
  windows: WindowView[];
  notes: Note[];
}

type ModelWindow = { name: string; utilization: number; resetsAt?: number | null };

/**
 * Whether a per-model window is doing anything on its account: it is spent,
 * or it has less left than the account's own week, so it would stop that
 * model before the week stops the account.
 */
function inPlay(account: DashboardAccount, window: ModelWindow, now: number): boolean {
  const used = effectiveUtilization(window.utilization, window.resetsAt, now);
  if (used === null) return false;
  const week = effectiveUtilization(account.usage?.sevenDay, account.usage?.sevenDayReset, now) ?? 0;
  return used >= 1 || used > week;
}

/**
 * Which model the model column is about, or null when it is not drawn.
 *
 * ONE model for the whole column, so every row under the heading holds the
 * same model's number: the model sessions prefer when its own limit is in
 * play on some account, otherwise whichever in-play limit binds hardest. No
 * limit in play means no column, which is most of the time.
 */
function columnModel(
  accounts: readonly DashboardAccount[],
  preferred: string | null,
  now: number,
): string | null {
  const live = accounts.flatMap((a) => (a.usage?.models ?? []).filter((m) => inPlay(a, m, now)));
  const first = live[0];
  if (!first) return null;
  const wanted = preferred ? normalizeModel(preferred) : null;
  const asked = live.find((m) => normalizeModel(m.name) === wanted);
  if (asked) return asked.name;
  const measured = (m: ModelWindow) => ({ used: m.utilization, resetsAt: m.resetsAt });
  return live.reduce((best, m) => (bindsHarder(measured(m), measured(best), now) ? m : best), first).name;
}

/** The column a blocking constraint from the shared status belongs to, if it has one. */
function columnOf(label: string, model: string | null): number | null {
  if (label === '5h') return 0;
  if (label === 'week') return 1;
  if (label === 'capped') return null;
  return model !== null && normalizeModel(label) === normalizeModel(model) ? 2 : null;
}

/**
 * Where a row out of room says when it is back: under the spent window that
 * lifts last, or null when no window in a column is spent (ccx was refused and
 * the numbers do not show why), and then the row says it at its end.
 *
 * The TIME it gives is always the status's own `until`, which is when the
 * last thing blocking lifts, including ccx's record of the refusal. Only the
 * place is chosen here.
 */
function backColumn(placed: Placed, model: string | null): number | null {
  let at: number | null = null;
  let latest = Number.NEGATIVE_INFINITY;
  for (const constraint of placed.status.constraints) {
    const column = columnOf(constraint.label, model);
    const until = constraint.until ?? Number.POSITIVE_INFINITY;
    if (column !== null && until >= latest) {
      at = column;
      latest = until;
    }
  }
  return at;
}

/** A reset time that is still ahead, or null: no window is running. */
const ahead = (resetsAt: number | null | undefined, now: number): number | null =>
  typeof resetsAt === 'number' && resetsAt > now ? resetsAt : null;

function windowsOf(placed: Placed, model: string | null, now: number): WindowView[] {
  const usage = placed.account.usage;
  const back = placed.block === 'out' ? backColumn(placed, model) : null;
  const windows: WindowView[] = [
    {
      used: effectiveUtilization(usage?.fiveHour, usage?.fiveHourReset, now),
      resetsAt: ahead(usage?.fiveHourReset, now),
      back: back === 0,
    },
    {
      used: effectiveUtilization(usage?.sevenDay, usage?.sevenDayReset, now),
      resetsAt: ahead(usage?.sevenDayReset, now),
      back: back === 1,
    },
  ];
  if (model !== null) {
    const key = normalizeModel(model);
    const own = (usage?.models ?? []).find((m) => normalizeModel(m.name) === key);
    windows.push({
      used: own ? effectiveUtilization(own.utilization, own.resetsAt, now) : null,
      resetsAt: ahead(own?.resetsAt, now),
      back: back === 2,
    });
  }
  return windows;
}

export interface TableInput {
  /** The accounts in the order they are drawn. */
  placed: readonly Placed[];
  now: number;
  /** The model sessions prefer, when anything pins one. */
  model: string | null;
  /** How many sessions are running on each account, by name. */
  sessions: ReadonlyMap<string, number>;
  /** The account a session would go to next, marked as next in line. */
  next: string | undefined;
}

export interface TableOptions {
  color: boolean;
  /** Columns to fit in. Absent means as wide as the frame wants. */
  width?: number;
  /** The row the cursor is on, counted in the order drawn. */
  selected?: number;
  /** A time of day in words, for waits under a day. */
  clock: (epochMs: number) => string;
}

export interface Table {
  header: string;
  /** One line per account, in the order given, with the block it belongs to. */
  rows: Array<{ block: Block; line: string }>;
  /** How many columns the widest line takes. */
  width: number;
}

/** What is said at the end of a row, besides when a window resets. */
function notesOf(placed: Placed, next: boolean, sessions: number): Note[] {
  const notes: Note[] = [];
  if (placed.status.state === 'logged-out') notes.push({ text: 'signed out', code: codes.red });
  if (placed.status.state === 'disabled') notes.push({ text: 'disabled', code: codes.dim });
  if (placed.block === 'usable') {
    if (next) notes.push({ text: 'next in line', short: 'next', code: codes.cyan });
    if (placed.account.pick?.heldBack) notes.push({ text: 'held back', code: codes.yellow });
  }
  if (sessions > 0) notes.push({ text: `${sessions} session${sessions === 1 ? '' : 's'}` });
  return notes;
}

/** Draw the table to fit `options.width`, giving up what LADDER says to, in its order. */
export function drawTable(input: TableInput, options: TableOptions): Table {
  const { placed, now } = input;
  const model = columnModel(
    placed.map((p) => p.account),
    input.model,
    now,
  );
  const rows: Row[] = placed.map((p, i) => {
    const next = p.block === 'usable' && p.account.name === input.next;
    return {
      placed: p,
      selected: i === options.selected,
      next,
      windows: windowsOf(p, model, now),
      notes: notesOf(p, next, input.sessions.get(p.account.name) ?? 0),
    };
  });

  /** A wait in words, with the time of day when the shape has clocks and the wait is under a day. */
  const wait = (until: number, shape: Shape): string =>
    `${hhmm(until, now)}${shape.clocks && until - now < DAY_MS ? ` (${options.clock(until)})` : ''}`;
  /** "back in 2d 8h", or "out" when nothing says when. */
  const backWords = (row: Row, shape: Shape): string => {
    const until = row.placed.status.until;
    return until === null ? 'out' : `back in ${wait(until, shape)}`;
  };
  /** What a window's cell says beside its bar. A window that is not running says nothing. */
  const resetOf = (row: Row, window: WindowView, shape: Shape): Run | null => {
    if (window.back) return { text: backWords(row, shape), code: codes.yellow };
    if (window.resetsAt === null) return null;
    const words = shape.words ? `resets in ${wait(window.resetsAt, shape)}` : hhmm(window.resetsAt, now);
    return { text: words, code: codes.dim };
  };
  const notesFor = (row: Row, shape: Shape): Run[] => {
    const said: Note[] = [...row.notes];
    // An account that is out, with no spent window to say it under.
    if (row.placed.block === 'out' && !row.windows.some((w) => w.back)) {
      said.unshift({ text: backWords(row, shape), code: codes.yellow });
    }
    return said.flatMap((note, i) => [
      ...(i > 0 ? [{ text: ' · ', code: codes.dim }] : []),
      { text: shape.words ? note.text : (note.short ?? note.text), ...(note.code ? { code: note.code } : {}) },
    ]);
  };

  const ranks = rows.map((r) => (r.placed.block === 'usable' ? r.placed.account.pick?.rank : undefined));
  const rankW = Math.max(1, ...ranks.map((rank) => (rank === undefined ? 0 : String(rank).length)));
  const fullNameW = Math.max('ACCOUNT'.length, ...rows.map((r) => r.placed.account.name.length));
  const titles = ['5-HOUR', 'WEEK', ...(model === null ? [] : [model.toUpperCase()])];
  const brief = ['5H', 'WK', ...(model === null ? [] : [model.toUpperCase()])];

  /** The whole table in one shape, with names cut to `nameW`. */
  const lay = (shape: Shape, nameW: number): { header: Run[]; lines: Run[][]; width: number } => {
    const gaugeW = shape.bar > 0 ? shape.bar + 5 : 4;
    const resets = rows.map((row) => row.windows.map((w) => (shape.resets ? resetOf(row, w, shape) : null)));
    const resetW = titles.map((_, i) => Math.max(0, ...resets.map((cells) => cells[i]?.text.length ?? 0)));
    const groupW = titles.map((_, i) => gaugeW + ((resetW[i] ?? 0) > 0 ? 2 + (resetW[i] ?? 0) : 0));
    const notes = rows.map((row) => (shape.notes ? notesFor(row, shape) : []));

    // Each heading is the longest of its forms that its column has room for,
    // so a heading never makes a column wider than its cells do.
    const headings = titles.map((title, i) => {
      const room = groupW[i] ?? gaugeW;
      const full = `${title} LEFT`;
      if (full.length <= room) return full;
      const short = `${brief[i] ?? title} LEFT`;
      return short.length <= room ? short : fit(brief[i] ?? title, room);
    });
    const account = fit('ACCOUNT', nameW);
    const header: Run[] = [gap(1 + rankW + 3), { text: account, code: codes.dim }, gap(nameW - account.length)];
    headings.forEach((text, i) =>
      header.push(gap(i === 0 ? 2 : 3), { text, code: codes.dim }, gap((groupW[i] ?? 0) - text.length)),
    );

    const lines = rows.map((row, r) => {
      const { account, block } = row.placed;
      const quiet = block !== 'usable';
      const rank = ranks[r] === undefined ? '' : String(ranks[r]);
      const name = fit(account.name, nameW);
      const runs: Run[] = [
        { text: row.selected ? '▸' : ' ', code: codes.cyan },
        { text: rank.padStart(rankW), code: row.next ? codes.cyan : codes.dim },
        gap(1),
        { text: account.active ? '*' : ' ', code: codes.cyan },
        gap(1),
        account.active
          ? { text: name, code: `${codes.bold}${codes.cyan}` }
          : { text: name, ...(quiet ? { code: codes.dim } : {}) },
        gap(nameW - name.length),
      ];
      row.windows.forEach((window, i) => {
        const left = window.used === null ? null : Math.max(0, 1 - window.used);
        const number = (left === null ? '?' : `${Math.round(left * 100)}%`).padStart(4);
        const reset = resets[r]?.[i] ?? null;
        runs.push(gap(i === 0 ? 2 : 3));
        if (shape.bar > 0) {
          // Drawn by what is left and coloured by what is used, on the scale
          // `ccx usage` colours by: a full green bar is an untouched window.
          runs.push({ text: bar(left, shape.bar), code: quiet ? codes.dim : shadeForUsed(window.used) }, gap(1));
        }
        runs.push({ text: number, ...(quiet ? { code: codes.dim } : {}) });
        const resetRoom = resetW[i] ?? 0;
        // A blank cell is still as wide as its column, so the next bar starts where the others do.
        if (resetRoom > 0) runs.push(gap(2), ...(reset ? [reset] : []), gap(resetRoom - (reset?.text.length ?? 0)));
      });
      const said = notes[r] ?? [];
      if (said.length > 0) runs.push(gap(3), ...said);
      return trimmed(runs);
    });

    const body = trimmed(header);
    return { header: body, lines, width: Math.max(visible(body), ...lines.map(visible)) };
  };

  const max = options.width && options.width > 0 ? options.width : Number.MAX_SAFE_INTEGER;
  let shape = LADDER[0] as Shape;
  let laid = lay(shape, fullNameW);
  for (const candidate of LADDER.slice(1)) {
    if (laid.width <= max) break;
    shape = candidate;
    laid = lay(shape, fullNameW);
  }
  // The narrowest shape and still too wide: the names give up the difference.
  if (laid.width > max) laid = lay(shape, Math.max(NAME_MIN, fullNameW - (laid.width - max)));
  // After that there is nothing left to give up, so a line that is still too
  // wide is cut rather than wrapped.
  const line = (runs: Run[]): string => draw(clip(runs, max), options.color);
  return {
    header: line(laid.header),
    rows: laid.lines.map((runs, i) => ({ block: (rows[i] as Row).placed.block, line: line(runs) })),
    width: Math.min(max, laid.width),
  };
}
