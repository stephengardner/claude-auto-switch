import { describe, it, expect } from 'vitest';
import { renderDashboard, type DashboardSnapshot, type DashboardAccount } from './render.js';
import { clockTime } from './table.js';

const NOW = 1_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function account(over: Partial<DashboardAccount> = {}): DashboardAccount {
  return {
    name: 'work',
    email: 'w@x.com',
    plan: 'max',
    loggedIn: true,
    active: false,
    enabled: true,
    priority: 0,
    ...over,
  };
}

function snapshot(accounts: DashboardAccount[], events: string[] = []): DashboardSnapshot {
  return { accounts, events, now: NOW, refreshMs: 3000 };
}

type Pick = NonNullable<DashboardAccount['pick']>;
const pick = (rank: number, over: Partial<Pick> = {}): Pick => ({ rank, runway: 1, binding: 'none', ...over });

/** A clock that does not depend on where the test runs. */
const utc = (epochMs: number): string => {
  const at = new Date(epochMs);
  return `${String(at.getUTCHours()).padStart(2, '0')}.${String(at.getUTCMinutes()).padStart(2, '0')}`;
};

const ESC = String.fromCharCode(27);
const plain = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');

/** The account rows: what is drawn between the headings and the rule under the table. */
function tableRows(out: string): string[] {
  const all = out.split('\n');
  const from = all.findIndex((l) => l.includes('ACCOUNT'));
  const to = all.findIndex((l, i) => i > from && /^─+$/.test(l));
  return all.slice(from + 1, to).filter((l) => !l.startsWith('──'));
}

/** One account's row. A name is always followed by a space or the end of the line. */
function rowOf(out: string, name: string): string {
  const row = tableRows(out).find((l) => l.includes(` ${name} `) || l.endsWith(` ${name}`));
  if (row === undefined) throw new Error(`no row for ${name} in:\n${out}`);
  return row;
}

const heading = (out: string): string => out.split('\n').find((l) => l.includes('ACCOUNT')) ?? '';

/**
 * The eight accounts the layout was agreed on, in the order they were added,
 * which is the order ccx hands them over in.
 */
function machine(): DashboardSnapshot {
  const out = (name: string, priority: number, backIn: number, fable = 0): DashboardAccount =>
    account({
      name,
      priority,
      // ccx's own record of the refusal lifts a moment after the window does,
      // as it does on a real machine.
      cappedUntil: NOW + backIn + 1000,
      usage: {
        fiveHour: 0,
        sevenDay: 1,
        fiveHourReset: null,
        sevenDayReset: NOW + backIn,
        models: [{ name: 'Fable', utilization: fable, resetsAt: NOW + backIn }],
      },
    });
  return {
    ...snapshot(
      [
        out('stephenalvi2', 0, 2 * DAY + 8 * HOUR),
        out('stephenalvi', 1, 2 * DAY + 21 * HOUR),
        out('stephenalvi3', 2, 4 * DAY + 9 * HOUR),
        account({
          name: 'stephenalvis2',
          priority: 3,
          usage: { fiveHour: 0, sevenDay: 0.97, fiveHourReset: null, sevenDayReset: NOW + 5 * DAY + 17 * HOUR },
          pick: pick(4, { runway: 0.2, binding: 'weekly', heldBack: { weekLeft: 0.03 } }),
        }),
        out('stephenalviz-proton', 4, 6 * DAY + 2 * HOUR, 0.02),
        account({
          name: 'stephenalviz2-proton',
          priority: 5,
          active: true,
          usage: {
            fiveHour: 0.29,
            sevenDay: 0.27,
            fiveHourReset: NOW + 4 * HOUR + 16 * MIN,
            sevenDayReset: NOW + 17 * HOUR + 6 * MIN,
          },
          pick: pick(3),
        }),
        account({
          name: 'christopherplumb2-proton',
          priority: 6,
          usage: {
            fiveHour: 0,
            sevenDay: 0,
            fiveHourReset: NOW + 4 * HOUR + 26 * MIN,
            sevenDayReset: NOW + 6 * DAY + 4 * HOUR,
          },
          pick: pick(2),
        }),
        account({
          name: 'christrod2026-gmail',
          priority: 7,
          usage: { fiveHour: 0, sevenDay: 0, fiveHourReset: null, sevenDayReset: NOW + 2 * DAY + 3 * HOUR },
          pick: pick(1),
        }),
      ],
      ['22:49  switching to "christopherplumb2-proton" (no restart; takes effect within ~30s)'],
    ),
    version: '2.3.2',
    model: 'opus',
    whenOut: {
      account: 'christrod2026-gmail',
      words: 'christrod2026-gmail (a full 5-hour window; its week resets in 2d 3h)',
    },
    sessions: [1, 2, 3, 4, 5].map((number) => ({
      number,
      where: `storefronts (${11000 + number})`,
      account: 'stephenalviz2-proton',
    })),
  };
}

describe('the agreed layout', () => {
  it('draws the whole frame as it was agreed', () => {
    // The frame the layout was agreed on, from the accounts above. Usable
    // accounts in pick order, the ones out of room under their own heading,
    // every bar showing what is left, every reset beside its own bar.
    const out = renderDashboard(machine(), { color: false, width: 120, clock: utc });
    const title = 'ccx 2.3.2';
    const starts = 'new sessions start on stephenalviz2-proton · Opus first';
    expect(out.split('\n')).toEqual([
      `${title}${' '.repeat(115 - title.length - starts.length)}${starts}`,
      '─'.repeat(115),
      '     ACCOUNT                   5-HOUR LEFT                         WEEK LEFT',
      ' 1   christrod2026-gmail       ██████████ 100%                     ██████████ 100%  resets in 2d 3h    next in line',
      ' 2   christopherplumb2-proton  ██████████ 100%  resets in 4h 26m   ██████████ 100%  resets in 6d 4h',
      ' 3 * stephenalviz2-proton      ███████░░░  71%  resets in 4h 16m   ███████░░░  73%  resets in 17h 6m   5 sessions',
      ' 4   stephenalvis2             ██████████ 100%                     █░░░░░░░░░   3%  resets in 5d 17h   held back',
      `── out of room ${'─'.repeat(100)}`,
      '     stephenalvi2              ██████████ 100%                     ░░░░░░░░░░   0%  back in 2d 8h',
      '     stephenalvi               ██████████ 100%                     ░░░░░░░░░░   0%  back in 2d 21h',
      '     stephenalvi3              ██████████ 100%                     ░░░░░░░░░░   0%  back in 4d 9h',
      '     stephenalviz-proton       ██████████ 100%                     ░░░░░░░░░░   0%  back in 6d 2h',
      '─'.repeat(115),
      ' when one runs out → christrod2026-gmail (a full 5-hour window; its week resets in 2d 3h)',
      ' recent  22:49 a session moved to christopherplumb2-proton',
    ]);
  });
});

/**
 * Accounts chosen to pull the columns apart if anything can: names from one
 * character to twenty-four, reset texts of every length including none, an
 * account that was never read, one out on its 5-hour window, one out on its
 * week, one signed out and one disabled.
 */
function ragged(): DashboardSnapshot {
  return {
    ...snapshot([
      account({
        name: 'a',
        active: true,
        pick: pick(2),
        // No 5-hour window running: its reset cell is blank.
        usage: { fiveHour: 0, sevenDay: 0.5, fiveHourReset: null, sevenDayReset: NOW + 6 * DAY },
      }),
      account({
        name: 'a-name-of-twenty-4-chars',
        pick: pick(1),
        usage: { fiveHour: 0.4, sevenDay: 0.1, fiveHourReset: NOW + 45 * MIN, sevenDayReset: NOW + 17 * HOUR + 6 * MIN },
      }),
      account({
        name: 'thirteen-long',
        pick: pick(11, { heldBack: { weekLeft: 0.05 } }),
        usage: {
          fiveHour: 0.07,
          sevenDay: 0.95,
          fiveHourReset: NOW + 4 * HOUR + 26 * MIN,
          sevenDayReset: NOW + 5 * DAY + 17 * HOUR,
        },
      }),
      account({ name: 'unread' }),
      account({
        name: 'hour-out',
        usage: { fiveHour: 1, sevenDay: 0.3, fiveHourReset: NOW + 23 * HOUR + 59 * MIN, sevenDayReset: NOW + 3 * DAY },
      }),
      account({
        name: 'week-out',
        usage: { fiveHour: 0, sevenDay: 1, fiveHourReset: null, sevenDayReset: NOW + 2 * DAY + 21 * HOUR },
      }),
      account({ name: 'signed-out', loggedIn: false, usage: { fiveHour: 0.2, sevenDay: 0.2 } }),
      account({ name: 'off', enabled: false }),
    ]),
    sessions: [{ number: 1, where: 'api', account: 'a' }],
  };
}

/** Where each gauge (a bar and its number) starts in a row drawn with bars. */
const gaugeStarts = (row: string): number[] =>
  [...row.matchAll(/(?:[█░]+|-{4,}) +(?:\d+%|\?)/g)].map((m) => m.index);

/** Where each number ends, which is what lines up when there are no bars. */
const numberEnds = (row: string): number[] =>
  [...row.matchAll(/\d+%|\?(?= |$)/g)].map((m) => m.index + m[0].length);

describe('columns that stay in line', () => {
  // Every width here leaves room for bars; the test after these covers the rest.
  const widths = [undefined, 200, 120, 110, 104];

  it('starts every WEEK LEFT bar at the same column, whatever the names and reset texts are', () => {
    // A frame where one row's week bar sat a character to the right of the
    // others was the correction this layout was agreed with. Every column is
    // as wide as its widest cell in the frame, blank cells included.
    for (const width of widths) {
      const out = renderDashboard(ragged(), { color: false, clock: utc, ...(width ? { width } : {}) });
      const rows = tableRows(out);
      expect(rows.length, `rows at ${width}`).toBe(8);
      const week = rows.map((row) => gaugeStarts(row)[1]);
      expect(week[0], `at ${width}`).toBeGreaterThan(0);
      expect(new Set(week).size, `week bars at ${width}:\n${out}`).toBe(1);
      expect(heading(out).indexOf('WEEK LEFT'), `heading at ${width}`).toBe(week[0]);
    }
  });

  it('starts every 5-HOUR LEFT bar at the same column too', () => {
    for (const width of widths) {
      const out = renderDashboard(ragged(), { color: false, clock: utc, ...(width ? { width } : {}) });
      const five = tableRows(out).map((row) => gaugeStarts(row)[0]);
      expect(five[0], `at ${width}`).toBeGreaterThan(0);
      expect(new Set(five).size, `5-hour bars at ${width}:\n${out}`).toBe(1);
      expect(heading(out).indexOf('5-HOUR LEFT'), `heading at ${width}`).toBe(five[0]);
    }
  });

  it('keeps the bars in line when the frame is in colour', () => {
    // Colour codes take no room on screen. A cell padded by its length in
    // characters, codes included, comes up short by the length of the codes.
    const out = plain(renderDashboard(ragged(), { color: true, clock: utc, width: 120 }));
    const rows = tableRows(out);
    expect(new Set(rows.map((row) => gaugeStarts(row)[0])).size).toBe(1);
    expect(new Set(rows.map((row) => gaugeStarts(row)[1])).size).toBe(1);
    expect(out).toBe(renderDashboard(ragged(), { color: false, clock: utc, width: 120 }));
  });

  it('keeps the numbers in line when there is no room for bars', () => {
    for (const width of [100, 80, 64]) {
      const out = renderDashboard(ragged(), { color: false, clock: utc, width });
      const rows = tableRows(out);
      expect(out, `at ${width}`).not.toMatch(/[█░]/);
      expect(new Set(rows.map((row) => numberEnds(row)[0])).size, `5-hour numbers at ${width}:\n${out}`).toBe(1);
      expect(new Set(rows.map((row) => numberEnds(row)[1])).size, `week numbers at ${width}:\n${out}`).toBe(1);
    }
  });

  it('starts every reset text of a column at the same column', () => {
    const out = renderDashboard(ragged(), { color: false, clock: utc, width: 120 });
    // The week column's, in the rows that have one: what follows the week bar.
    const starts = tableRows(out).flatMap((row) => {
      const week = gaugeStarts(row)[1] ?? 0;
      const at = row.slice(week).search(/resets in|back in/);
      return at < 0 ? [] : [week + at];
    });
    expect(starts.length).toBe(5);
    expect(new Set(starts).size).toBe(1);
  });

  it('keeps a model column in line with the other two', () => {
    const base = ragged();
    const first = base.accounts[0];
    if (!first?.usage) throw new Error('the first account has usage');
    first.usage.models = [{ name: 'Fable', utilization: 0.9, resetsAt: NOW + 2 * DAY }];
    for (const width of [undefined, 160, 140]) {
      const out = renderDashboard(base, { color: false, clock: utc, ...(width ? { width } : {}) });
      const model = tableRows(out).map((row) => gaugeStarts(row)[2]);
      expect(model[0], `at ${width}`).toBeGreaterThan(0);
      expect(new Set(model).size, `model bars at ${width}:\n${out}`).toBe(1);
      expect(heading(out).indexOf('FABLE LEFT'), `heading at ${width}`).toBe(model[0]);
    }
  });

  it('makes room for a pick order that runs to two digits', () => {
    const out = renderDashboard(ragged(), { color: false, clock: utc, width: 120 });
    expect(rowOf(out, 'thirteen-long')).toMatch(/^ 11 {3}thirteen-long /);
    expect(rowOf(out, 'a')).toMatch(/^ {2}2 \* a /);
  });
});

describe('what is left', () => {
  const opts = { color: false as const, clock: utc };

  it('draws and counts what is left, as the status line does', () => {
    // The status line says "70% left". A bar here that filled up as the
    // window was spent meant a full bar was good news in one place and bad
    // news in the other.
    const out = renderDashboard(
      snapshot([
        account({ name: 'part', usage: { fiveHour: 0.29, sevenDay: 0.27 } }),
        account({ name: 'fresh', usage: { fiveHour: 0, sevenDay: 0 } }),
        account({ name: 'spent', usage: { fiveHour: 0, sevenDay: 1 } }),
      ]),
      opts,
    );
    expect(heading(out)).toContain('5-HOUR LEFT');
    expect(heading(out)).toContain('WEEK LEFT');
    expect(rowOf(out, 'part')).toContain('███████░░░  71%');
    expect(rowOf(out, 'part')).toContain('███████░░░  73%');
    expect(rowOf(out, 'fresh')).toContain('██████████ 100%');
    expect(rowOf(out, 'spent')).toContain('░░░░░░░░░░   0%');
  });

  it('draws an empty bar only when nothing is left, and a full one only when nothing is used', () => {
    const out = renderDashboard(
      snapshot([account({ name: 'sliver', usage: { fiveHour: 0.004, sevenDay: 0.97 } })]),
      opts,
    );
    const row = rowOf(out, 'sliver');
    expect(row).toContain('█████████░ 100%'); // something is used, so not quite full
    expect(row).toContain('█░░░░░░░░░   3%'); // something is left, so not quite empty
  });

  it('marks an unread window as unknown, never as empty or full', () => {
    // Full would claim the account is completely free when the truth is that
    // nobody has looked. The usage page says `?` for the same thing.
    const row = rowOf(renderDashboard(snapshot([account({ name: 'fresh' })]), opts), 'fresh');
    expect(row).toContain('?');
    expect(row).not.toContain('%');
    expect(row).not.toMatch(/[█░]/);
  });

  it('reads a window that has reset as full again', () => {
    // A number past its own reset records a limit that has already lifted.
    const out = renderDashboard(
      snapshot([
        account({
          name: 'lifted',
          usage: { fiveHour: 1, sevenDay: 1, fiveHourReset: NOW - 1, sevenDayReset: NOW - 1 },
        }),
      ]),
      opts,
    );
    expect(rowOf(out, 'lifted')).not.toContain('  0%');
    expect(rowOf(out, 'lifted').match(/100%/g)?.length).toBe(2);
    expect(out).not.toContain('out of room');
  });
});

describe('when each window resets', () => {
  const opts = { color: false as const, clock: utc };

  it('says when each window resets, beside the bar it belongs to', () => {
    const out = renderDashboard(
      snapshot([
        account({
          name: 'work',
          usage: {
            fiveHour: 0.29,
            sevenDay: 0.27,
            fiveHourReset: NOW + 4 * HOUR + 16 * MIN,
            sevenDayReset: NOW + 3 * DAY,
          },
        }),
      ]),
      { ...opts, width: 80 },
    );
    expect(rowOf(out, 'work')).toMatch(/71% {2}resets in 4h 16m +[█░]+ +73% {2}resets in 3d$/);
  });

  it('leaves the 5-hour cell blank when no window is running, and keeps its width', () => {
    // A 5-hour window starts at first use, so until then there is no reset to
    // give. The cell is empty rather than worded, and still as wide as the
    // other rows make it, so the week bar under it does not move.
    const out = renderDashboard(
      snapshot([
        account({
          name: 'idle',
          usage: { fiveHour: 0, sevenDay: 0.2, fiveHourReset: null, sevenDayReset: NOW + 3 * DAY },
        }),
        account({
          name: 'busy',
          usage: {
            fiveHour: 0.5,
            sevenDay: 0.2,
            fiveHourReset: NOW + 2 * HOUR + 10 * MIN,
            sevenDayReset: NOW + 3 * DAY,
          },
        }),
      ]),
      { ...opts, width: 80 },
    );
    expect(out).not.toContain('not started');
    // Two spaces, the sixteen that "resets in 2h 10m" takes in the row below, and three more.
    expect(rowOf(out, 'busy')).toContain(' 50%  resets in 2h 10m   ');
    expect(rowOf(out, 'idle')).toMatch(/100% {21}[█░]/);
    expect(gaugeStarts(rowOf(out, 'idle'))[1]).toBe(gaugeStarts(rowOf(out, 'busy'))[1]);
  });

  it('adds the clock time to a wait under a day, when there is room for it', () => {
    const out = renderDashboard(
      snapshot([
        account({
          name: 'work',
          usage: {
            fiveHour: 0.5,
            sevenDay: 0.5,
            fiveHourReset: NOW + 4 * HOUR + 16 * MIN,
            sevenDayReset: NOW + 3 * DAY,
          },
        }),
      ]),
      opts,
    );
    expect(rowOf(out, 'work')).toContain(`resets in 4h 16m (${utc(NOW + 4 * HOUR + 16 * MIN)})`);
    // A day or more away, the time of day says little and the date is missing.
    expect(rowOf(out, 'work')).toMatch(/resets in 3d$/);
  });

  it('reads a clock time as a 12-hour clock does', () => {
    expect(clockTime(new Date(2026, 0, 15, 3, 15).getTime())).toBe('3:15 AM');
    expect(clockTime(new Date(2026, 0, 15, 15, 5).getTime())).toBe('3:05 PM');
    expect(clockTime(new Date(2026, 0, 15, 0, 0).getTime())).toBe('12:00 AM');
    expect(clockTime(new Date(2026, 0, 15, 12, 30).getTime())).toBe('12:30 PM');
  });

  it('reads a long wait in days, not in dozens of hours', () => {
    const out = renderDashboard(
      snapshot([
        account({
          name: 'work',
          usage: { fiveHour: 0.1, sevenDay: 0.5, fiveHourReset: NOW + 95 * MIN, sevenDayReset: NOW + 3 * DAY },
        }),
      ]),
      { ...opts, width: 80 },
    );
    expect(rowOf(out, 'work')).toContain('resets in 3d');
    expect(rowOf(out, 'work')).not.toContain('72h');
    expect(rowOf(out, 'work')).toContain('resets in 1h 35m'); // hours keep their minutes
  });

  it('says back in, under the window that is blocking, for an account that is out', () => {
    const out = renderDashboard(
      snapshot([
        account({
          name: 'spent',
          usage: { fiveHour: 0, sevenDay: 1, fiveHourReset: null, sevenDayReset: NOW + 2 * DAY + 8 * HOUR },
        }),
        account({
          name: 'hourly',
          usage: { fiveHour: 1, sevenDay: 0.2, fiveHourReset: NOW + 3 * HOUR, sevenDayReset: NOW + 40 * HOUR },
        }),
      ]),
      { ...opts, width: 84 },
    );
    expect(rowOf(out, 'spent')).toMatch(/ {2}0% {2}back in 2d 8h$/);
    expect(rowOf(out, 'hourly')).toMatch(/ {2}0% {2}back in 3h 0m +[█░]+ +80% {2}resets in 1d 16h$/);
  });

  it('gives the wait until the LAST thing blocking lifts, because that is when it is usable', () => {
    // The same rule `ccx state` publishes as status.until. Taking the earliest
    // would promise a return that is not coming.
    const out = renderDashboard(
      snapshot([
        account({
          name: 'both',
          usage: {
            fiveHour: 1,
            sevenDay: 1,
            fiveHourReset: NOW + 2 * HOUR, // back soon
            sevenDayReset: NOW + 4 * DAY, // the real wait
          },
        }),
      ]),
      { ...opts, width: 80 },
    );
    const row = rowOf(out, 'both');
    expect(row).toContain('resets in 2h 0m');
    expect(row).toMatch(/back in 4d$/);
    expect(row.match(/back in/g)?.length).toBe(1);
  });

  it("says back in under the spent window when ccx's own record of the refusal lifts a moment later", () => {
    // ccx records being refused, with a time of its own, a little after the
    // window's. That record has no column. The wait is still the last thing to
    // lift, and it is said where the spent window is.
    const out = renderDashboard(
      snapshot([
        account({
          name: 'refused',
          cappedUntil: NOW + 2 * DAY + 8 * HOUR + 20 * MIN,
          usage: { fiveHour: 0, sevenDay: 1, sevenDayReset: NOW + 2 * DAY + 8 * HOUR },
        }),
      ]),
      { ...opts, width: 110 },
    );
    expect(rowOf(out, 'refused')).toMatch(/ {2}0% {2}back in 2d 8h$/);
  });

  it('says back in at the end of the row when no window on it is spent', () => {
    // ccx was refused, and the numbers have not caught up or never will.
    const out = renderDashboard(
      snapshot([
        account({
          name: 'refused',
          cappedUntil: NOW + 30 * MIN,
          usage: { fiveHour: 0.2, sevenDay: 0.2, fiveHourReset: NOW + 2 * HOUR, sevenDayReset: NOW + 3 * DAY },
        }),
      ]),
      { ...opts, width: 100 },
    );
    expect(out).toContain('out of room');
    expect(rowOf(out, 'refused')).toMatch(/resets in 2h 0m +[█░]+ +80% {2}resets in 3d {3}back in 30m$/);
  });

  it('says out when nothing says when it comes back', () => {
    const out = renderDashboard(
      snapshot([account({ name: 'unknown', usage: { fiveHour: 0, sevenDay: 1 } })]),
      { ...opts, width: 110 },
    );
    expect(rowOf(out, 'unknown')).toMatch(/ {2}0% {2}out$/);
  });
});

describe('usable accounts first, the rest below', () => {
  const opts = { color: false as const, clock: utc, width: 120 };

  it('lists usable accounts in pick order, then the ones out of room, soonest back first', () => {
    const out = renderDashboard(machine(), opts);
    const names = tableRows(out).map((row) => row.slice(5).split(' ')[0]);
    expect(names).toEqual([
      'christrod2026-gmail',
      'christopherplumb2-proton',
      'stephenalviz2-proton',
      'stephenalvis2',
      'stephenalvi2',
      'stephenalvi',
      'stephenalvi3',
      'stephenalviz-proton',
    ]);
    const lines = out.split('\n');
    const divider = lines.findIndex((l) => l.startsWith('── out of room '));
    expect(divider).toBe(lines.findIndex((l) => l.includes(' stephenalvis2 ')) + 1);
  });

  it('numbers the usable accounts by pick order and leaves the others unnumbered', () => {
    const out = renderDashboard(machine(), opts);
    expect(rowOf(out, 'christrod2026-gmail')).toMatch(/^ 1 {3}christrod2026-gmail /);
    expect(rowOf(out, 'stephenalvis2')).toMatch(/^ 4 {3}stephenalvis2 /);
    expect(rowOf(out, 'stephenalvi2')).toMatch(/^ {5}stephenalvi2 /);
  });

  it('uses one word for out, whatever stopped the account', () => {
    // "capped" and "week spent" were two words for one thing to the person
    // reading: this account is out until a time.
    const out = renderDashboard(machine(), opts);
    expect(out).not.toContain('capped');
    expect(out).not.toContain('spent');
    expect(out).not.toContain('ready');
    expect(out.match(/back in/g)?.length).toBe(4);
  });

  it('says an account is held back, rather than calling it ready', () => {
    const out = renderDashboard(machine(), opts);
    expect(rowOf(out, 'stephenalvis2')).toMatch(/held back$/);
  });

  it('marks as next the account the line under the table names', () => {
    // Rank 1 is the next pick by account. The line under the table is the
    // plan, which also weighs the model, and can name another. One screen
    // must not point at two accounts.
    const state = machine();
    state.whenOut = { account: 'christopherplumb2-proton', words: 'christopherplumb2-proton' };
    const out = renderDashboard(state, opts);
    expect(rowOf(out, 'christopherplumb2-proton')).toMatch(/next in line$/);
    expect(rowOf(out, 'christrod2026-gmail')).not.toContain('next in line');
  });

  it('marks the first pick as next when nothing says where a session would go', () => {
    const state = machine();
    delete state.whenOut;
    const out = renderDashboard(state, opts);
    expect(rowOf(out, 'christrod2026-gmail')).toMatch(/next in line$/);
    expect(out).not.toContain('when one runs out');
  });

  it('marks no account as next when there is nowhere to go', () => {
    const state = machine();
    state.whenOut = { words: 'every account is out of opus and fable' };
    const out = renderDashboard(state, opts);
    expect(out).not.toContain('next in line');
    expect(out).toContain(' when one runs out → every account is out of opus and fable');
  });

  it('keeps its mark on the account new sessions start on, and names it in the title', () => {
    const out = renderDashboard(machine(), opts);
    expect(rowOf(out, 'stephenalviz2-proton')).toMatch(/^ 3 \* stephenalviz2-proton /);
    expect(out.split('\n')[0]).toMatch(/^ccx 2\.3\.2 +new sessions start on stephenalviz2-proton · Opus first$/);
    expect(tableRows(out).filter((row) => row.includes('*')).length).toBe(1);
  });

  it('says so in the title when no account is set for new sessions', () => {
    const out = renderDashboard(snapshot([account({ name: 'a' })]), opts);
    expect(out.split('\n')[0]).toMatch(/^ccx +no account chosen for new sessions$/);
  });

  it('NEVER lists as usable an account whose own row shows a spent window', () => {
    // The old bug, in the operator's words: "how could it be ready yet 5h is
    // capped?". The status came from ccx's ledger while the numbers beside it
    // came from the API, and nothing compared the two.
    const out = renderDashboard(
      {
        ...snapshot([
          account({ name: 'fine', pick: pick(1), usage: { fiveHour: 0.1, sevenDay: 0.1 } }),
          account({
            name: 'ninetynine',
            usage: {
              fiveHour: 1,
              sevenDay: 0.2,
              fiveHourReset: NOW + 3 * HOUR,
              sevenDayReset: NOW + 40 * HOUR,
              models: [{ name: 'Fable', utilization: 0.34, resetsAt: NOW + 40 * HOUR }],
            },
          }),
        ]),
        model: 'fable',
      },
      opts,
    );
    const lines = out.split('\n');
    const divider = lines.findIndex((l) => l.startsWith('── out of room '));
    expect(divider).toBeGreaterThan(0);
    expect(lines.findIndex((l) => l.includes(' ninetynine '))).toBeGreaterThan(divider);
    expect(rowOf(out, 'ninetynine')).toContain('back in 3h 0m');
  });

  it('lists signed-out and disabled accounts under a heading of their own', () => {
    // Neither is out of room, and no reset brings either back.
    const out = renderDashboard(
      snapshot([
        account({ name: 'off1', enabled: false, usage: { fiveHour: 0.2, sevenDay: 0.2 } }),
        account({ name: 'out1', loggedIn: false }),
        account({ name: 'cap1', cappedUntil: NOW + 30 * MIN }),
        account({ name: 'ready1', pick: pick(1) }),
      ]),
      opts,
    );
    const lines = out.split('\n');
    const at = (text: string): number => lines.findIndex((l) => l.includes(text));
    expect(at(' ready1 ')).toBeLessThan(at('── out of room '));
    expect(at('── out of room ')).toBeLessThan(at(' cap1 '));
    expect(at(' cap1 ')).toBeLessThan(at('── not in rotation '));
    expect(at('── not in rotation ')).toBeLessThan(at(' out1 '));
    expect(at(' out1 ')).toBeLessThan(at(' off1 '));
    expect(rowOf(out, 'out1')).toMatch(/signed out$/);
    expect(rowOf(out, 'off1')).toMatch(/disabled$/);
    expect(rowOf(out, 'cap1')).toContain('back in 30m');
  });

  it('draws no heading for a block with nothing in it', () => {
    const out = renderDashboard(snapshot([account({ name: 'a', pick: pick(1) })]), opts);
    expect(out).not.toContain('out of room');
    expect(out).not.toContain('not in rotation');
  });

  it('puts the cursor on the selected row, counted in the order drawn', () => {
    // Row 4 on screen is the first account out of room, whatever position it
    // was added in.
    const out = renderDashboard(machine(), { ...opts, selected: 4 });
    expect(rowOf(out, 'stephenalvi2')).toMatch(/^▸ {4}stephenalvi2 /);
    expect(tableRows(out).filter((row) => row.startsWith('▸')).length).toBe(1);
    const first = renderDashboard(machine(), { ...opts, selected: 0 });
    expect(rowOf(first, 'christrod2026-gmail')).toMatch(/^▸1 {3}christrod2026-gmail /);
  });

  it('says what to do when there are no accounts, instead of an empty table', () => {
    // Whoever sees this has just installed ccx. A header with nothing under it
    // reads as broken, and leaves them guessing.
    const out = renderDashboard(snapshot([]), opts);
    expect(out).toContain('ccx add');
    expect(out).not.toContain('ACCOUNT');
  });
});

describe('sessions', () => {
  const opts = { color: false as const, clock: utc, width: 120 };
  const sessions = [
    { number: 1, where: 'api', account: 'a' },
    { number: 2, where: 'web', account: 'b' },
    { number: 3, where: 'cli', account: 'b' },
  ];

  it('counts the sessions on each account in its row, instead of listing them all on one line', () => {
    const out = renderDashboard(
      {
        ...snapshot([account({ name: 'a' }), account({ name: 'b' }), account({ name: 'c' })]),
        sessions,
      },
      opts,
    );
    expect(rowOf(out, 'a')).toMatch(/1 session$/);
    expect(rowOf(out, 'b')).toMatch(/2 sessions$/);
    expect(rowOf(out, 'c')).not.toContain('session');
    expect(out).not.toContain('sessions:');
    expect(out).not.toContain('api');
  });

  it('says so beside whatever else the row has to say', () => {
    const out = renderDashboard(
      {
        ...snapshot([account({ name: 'a', pick: pick(1) }), account({ name: 'b', loggedIn: false })]),
        sessions,
      },
      opts,
    );
    expect(rowOf(out, 'a')).toMatch(/next in line · 1 session$/);
    expect(rowOf(out, 'b')).toMatch(/signed out · 2 sessions$/);
  });

  it('still says a session is running when its account is no longer listed', () => {
    // A session keeps going on an account that was removed until it next
    // moves. With no row to count it in, it gets a line.
    const out = renderDashboard({ ...snapshot([account({ name: 'a' })]), sessions }, opts);
    expect(out).toContain(' 2 sessions on an account no longer here: b');
  });
});

describe('the model column', () => {
  const opts = { color: false as const, clock: utc, width: 160 };

  it('is not drawn while no per-model limit is in play', () => {
    // It was a third of the width and almost always zeros. A model window
    // with room to spare on an account whose own week is the tighter limit
    // stops nothing.
    const out = renderDashboard(machine(), { ...opts, width: 120 });
    expect(out).not.toContain('FABLE');
    expect(tableRows(out).every((row) => gaugeStarts(row).length === 2)).toBe(true);
  });

  it("is drawn when a model's own week is tighter than the account's", () => {
    const out = renderDashboard(
      snapshot([
        account({
          name: 'tight',
          usage: {
            fiveHour: 0,
            sevenDay: 0.4,
            sevenDayReset: NOW + 3 * DAY,
            models: [{ name: 'Fable', utilization: 0.9, resetsAt: NOW + 2 * DAY }],
          },
        }),
        account({ name: 'roomy', usage: { fiveHour: 0, sevenDay: 0.4, models: [{ name: 'Fable', utilization: 0.1 }] } }),
      ]),
      opts,
    );
    expect(heading(out)).toContain('FABLE LEFT');
    expect(rowOf(out, 'tight')).toMatch(/█░░░░░░░░░ {2}10% {2}resets in 2d$/);
    expect(rowOf(out, 'roomy')).toMatch(/█████████░ {2}90%$/);
  });

  it('is drawn when a model is spent, and reads full again once that window has reset', () => {
    const spent = (resetsAt: number): DashboardSnapshot =>
      snapshot([
        account({
          name: 'main',
          usage: { fiveHour: 0, sevenDay: 0, models: [{ name: 'Fable', utilization: 1, resetsAt }] },
        }),
      ]);
    expect(heading(renderDashboard(spent(NOW + HOUR), opts))).toContain('FABLE LEFT');
    expect(rowOf(renderDashboard(spent(NOW + HOUR), opts), 'main')).toContain('░░░░░░░░░░   0%');
    // Showing Fable as spent for a window that reset hours ago reads as "do
    // not use this account".
    const lifted = renderDashboard(spent(NOW - 1), opts);
    expect(lifted).not.toContain('FABLE');
    expect(lifted).not.toContain('  0%');
  });

  it('shows the SAME model in every row', () => {
    // A column named after one model must hold that model's number in every
    // row. Filling each cell with that account's own worst model made the
    // heading a lie for any row whose worst was something else.
    const out = renderDashboard(
      snapshot([
        account({
          name: 'main',
          usage: {
            fiveHour: 0,
            sevenDay: 0,
            models: [
              { name: 'Fable', utilization: 1, resetsAt: NOW + 9_000_000 },
              { name: 'Opus', utilization: 0.1, resetsAt: NOW + 9_000_000 },
            ],
          },
        }),
        account({
          name: 'phx',
          usage: {
            fiveHour: 0,
            sevenDay: 0,
            models: [
              { name: 'Fable', utilization: 0.2, resetsAt: NOW + 9_000_000 },
              { name: 'Opus', utilization: 0.7, resetsAt: NOW + 9_000_000 },
            ],
          },
        }),
      ]),
      opts,
    );
    expect(heading(out)).toContain('FABLE LEFT');
    expect(rowOf(out, 'phx')).toContain(' 80%'); // its Fable, which the column is about
    expect(rowOf(out, 'phx')).not.toContain(' 30%'); // not its Opus, which the heading does not name
  });

  it('is about the model sessions prefer when that one is in play', () => {
    const state = snapshot([
      account({
        name: 'main',
        usage: {
          fiveHour: 0,
          sevenDay: 0,
          models: [
            { name: 'Fable', utilization: 0.9, resetsAt: NOW + DAY },
            { name: 'Opus', utilization: 0.5, resetsAt: NOW + DAY },
          ],
        },
      }),
    ]);
    // With no preference, the one that binds hardest.
    expect(heading(renderDashboard(state, opts))).toContain('FABLE LEFT');
    expect(heading(renderDashboard({ ...state, model: 'claude-opus-5[1m]' }, opts))).toContain('OPUS LEFT');
  });

  it('names the model still running when another, listed first, has reset', () => {
    const out = renderDashboard(
      snapshot([
        account({
          name: 'mixed',
          usage: {
            fiveHour: 0,
            sevenDay: 0,
            models: [
              { name: 'Fable', utilization: 1, resetsAt: NOW - 1 }, // over
              { name: 'Opus', utilization: 0.5, resetsAt: NOW + MIN }, // the one that can still stop you
            ],
          },
        }),
      ]),
      opts,
    );
    expect(heading(out)).toContain('OPUS LEFT');
    expect(out).not.toContain('FABLE');
    expect(rowOf(out, 'mixed')).toContain(' 50%');
  });

  it('keeps an account whose preferred model is spent among the usable ones, with that model shown empty', () => {
    // The account-wide windows are fine and rotation ranks it, because it can
    // run the next model in the chain. Calling it out of room would be wrong,
    // and so would a full row with nothing to say the model is gone.
    const out = renderDashboard(
      {
        ...snapshot([
          account({
            name: 'maxed',
            pick: pick(1),
            usage: {
              fiveHour: 0.05,
              sevenDay: 0.82,
              fiveHourReset: NOW + HOUR,
              sevenDayReset: NOW + 40 * HOUR,
              models: [{ name: 'Fable', utilization: 1, resetsAt: NOW + 40 * HOUR }],
            },
          }),
        ]),
        model: 'fable',
      },
      opts,
    );
    expect(out).not.toContain('out of room');
    expect(rowOf(out, 'maxed')).toMatch(/^ 1 {3}maxed /);
    expect(rowOf(out, 'maxed')).toMatch(/░░░░░░░░░░ {3}0% {2}resets in 1d 16h/);
  });

  it('says back in under the model when the model is the last thing to lift', () => {
    // Asked for directly: "when fable is out, 100%, I want to know how long
    // until it returns".
    const out = renderDashboard(
      {
        ...snapshot([
          account({
            name: 'main',
            usage: {
              fiveHour: 0,
              sevenDay: 1,
              fiveHourReset: NOW + HOUR,
              sevenDayReset: NOW + 10 * HOUR,
              models: [{ name: 'Fable', utilization: 1, resetsAt: NOW + 68 * HOUR }], // lifts LAST
            },
          }),
        ]),
        model: 'fable',
      },
      opts,
    );
    const row = rowOf(out, 'main');
    expect(row).toMatch(/back in 2d 20h$/);
    expect(row).toContain(`resets in 10h 0m (${utc(NOW + 10 * HOUR)})`);
    expect(row.match(/back in/g)?.length).toBe(1);
  });

  it('never lets a long model name push the row past the terminal', () => {
    const out = renderDashboard(
      snapshot([
        account({
          name: 'main',
          usage: {
            fiveHour: 0,
            sevenDay: 0,
            models: [{ name: 'claude-fable-5-with-a-very-long-name', utilization: 1, resetsAt: NOW + 9e6 }],
          },
        }),
      ]),
      { ...opts, width: 60 },
    );
    for (const line of out.split('\n')) expect(line.length, line).toBeLessThanOrEqual(60);
    expect(heading(out)).toMatch(/CLAUDE-F[A-Z0-9-]*…/);
  });
});

describe('recent activity', () => {
  const opts = { color: false as const, clock: utc, width: 120 };

  it('says what happened in plain words, a few lines at most, under one label', () => {
    const out = renderDashboard(
      snapshot(
        [account()],
        [
          '22:31  switching to "a" (no restart; takes effect within ~30s)',
          '22:31  switching to "b" (no restart; takes effect within ~30s)',
          '22:49  session on b (x2)',
          '22:49  switching to "a" (no restart; takes effect within ~30s)',
          '22:49  switching to "b" (no restart; takes effect within ~30s)',
        ],
      ),
      opts,
    );
    const lines = out.split('\n');
    const at = lines.findIndex((l) => l.startsWith(' recent  '));
    expect(lines.slice(at)).toEqual([
      ' recent  22:49 a session started on b (x2)',
      '         22:49 a session moved to a (x2)',
      '         22:49 a session moved to b (x2)',
    ]);
    expect(out).not.toContain('no restart');
  });

  it('draws nothing for it when nothing has happened', () => {
    expect(renderDashboard(snapshot([account()]), opts)).not.toContain('recent');
  });
});

describe('narrow terminals', () => {
  const at = (width: number): string => renderDashboard(machine(), { color: false, clock: utc, width });
  const fits = (out: string, width: number): void => {
    for (const line of out.split('\n')) expect(line.length, `at ${width}: ${line}`).toBeLessThanOrEqual(width);
  };

  it('has room for clock times only on a wide terminal, and drops them first', () => {
    const wide = at(140);
    fits(wide, 140);
    expect(rowOf(wide, 'stephenalviz2-proton')).toContain(`resets in 4h 16m (${utc(NOW + 4 * HOUR + 16 * MIN)})`);
    expect(rowOf(wide, 'stephenalviz2-proton')).toContain('███████░░░  71%');
    const out = at(120);
    fits(out, 120);
    expect(tableRows(out).join('\n')).not.toContain('(');
    expect(rowOf(out, 'stephenalviz2-proton')).toContain('███████░░░  71%  resets in 4h 16m ');
  });

  it('narrows the bars next, before anything said in words goes', () => {
    const out = at(110);
    fits(out, 110);
    expect(rowOf(out, 'stephenalviz2-proton')).toMatch(
      /[█░]{7} {2}71% {2}resets in 4h 16m +[█░]{7} {2}73% {2}resets in 17h 6m +5 sessions$/,
    );
    expect(out).not.toMatch(/[█░]{8}/);
    expect(rowOf(out, 'christrod2026-gmail')).toMatch(/resets in 2d 3h +next in line$/);
  });

  it('at 100 columns drops the bars, keeping every number and every reset in words', () => {
    const out = at(100);
    fits(out, 100);
    expect(tableRows(out).join('\n')).not.toMatch(/[█░]/);
    expect(rowOf(out, 'stephenalviz2-proton')).toMatch(
      /^ 3 \* stephenalviz2-proton {6} 71% {2}resets in 4h 16m {4}73% {2}resets in 17h 6m {3}5 sessions$/,
    );
    expect(rowOf(out, 'stephenalvi')).toMatch(/ {2}0% {2}back in 2d 21h$/);
    expect(rowOf(out, 'christrod2026-gmail')).toMatch(/resets in 2d 3h +next in line$/);
    expect(rowOf(out, 'stephenalvis2')).toMatch(/ {2}3% {2}resets in 5d 17h +held back$/);
  });

  it('at 80 columns also drops the words "resets in", keeping every number, reset time, note and whole name', () => {
    const out = at(80);
    fits(out, 80);
    expect(tableRows(out).join('\n')).not.toMatch(/[█░]/);
    expect(rowOf(out, 'stephenalviz2-proton')).toMatch(/^ 3 \* stephenalviz2-proton {6} 71% {2}4h 16m +73% {2}17h 6m +5 sessions$/);
    expect(rowOf(out, 'christopherplumb2-proton')).toMatch(/^ 2 {3}christopherplumb2-proton {2}100% {2}4h 26m +100% {2}6d 4h$/);
    expect(rowOf(out, 'stephenalvi3')).toMatch(/ {2}0% {2}back in 4d 9h$/);
    expect(rowOf(out, 'stephenalvis2')).toMatch(/ {2}3% {2}5d 17h +held back$/);
    expect(heading(out)).toMatch(/ACCOUNT +5-HOUR LEFT +WEEK LEFT/);
  });

  it('drops the notes next, then the resets, and shortens names last of all', () => {
    const notes = at(70);
    fits(notes, 70);
    expect(notes).not.toContain('held back');
    expect(rowOf(notes, 'stephenalvi2')).toMatch(/back in 2d 8h$/);
    expect(rowOf(notes, 'christopherplumb2-proton')).toContain('4h 26m');

    const resets = at(50);
    fits(resets, 50);
    expect(tableRows(resets).join('\n')).not.toMatch(/back in|\dh /);
    expect(rowOf(resets, 'christopherplumb2-proton')).toMatch(/^ 2 {3}christopherplumb2-proton {2}100% {3}100%$/);
    expect(heading(resets)).toMatch(/ACCOUNT +5H +WK$/);

    const names = at(39);
    fits(names, 39);
    expect(names).toContain('christopherplumb2-pr…');
    expect(names).toContain(' 71%');
  });

  it('never wraps a row, at any width, with everything about an account as long as it can be', () => {
    // Long in every direction that free text can be long: the name, the
    // address, the wait, the model name, the events and the line under the
    // table. A wrapped row is the thing all of this exists to prevent.
    const wide = account({
      name: 'a-rather-long-account-name',
      email: 'someone.with.a.long.address@a-long-domain.example.com',
      plan: 'max-with-a-long-plan-name',
      cappedUntil: NOW + 12 * DAY,
      usage: {
        fiveHour: 1,
        sevenDay: 1,
        fiveHourReset: NOW + 90 * MIN,
        sevenDayReset: NOW + 6 * DAY + 23 * HOUR,
        models: [{ name: 'claude-fable-5-with-a-very-long-name', utilization: 1, resetsAt: NOW + 9e6 }],
      },
    });
    for (const width of [200, 120, 100, 92, 80, 64, 50, 40, 30, 20]) {
      const out = renderDashboard(
        {
          ...snapshot(
            [wide, account({ name: 'b', active: true, pick: pick(12) })],
            ['09:12  switching to "personal" (no restart; takes effect within ~30s)'],
          ),
          whenOut: { account: 'b', words: 'a-rather-long-account-name, on Fable instead (80% of Fable left)' },
          model: 'claude-fable-5',
          version: '2.3.2',
          settings: { model: 'Opus, then Fable', order: 'longest run first', holdBack: 'weeks 80%+ used' },
          desktop: { line: 'Desktop  on stephen, week spent for 4d 17h (past its plan) · 2 busy, 8 idle', keys: 'd moves' },
          sessions: [
            { number: 1, where: 'api', account: 'a-rather-long-account-name' },
            { number: 2, where: 'web', account: 'gone' },
          ],
        },
        { color: false, clock: utc, width, interactive: true, selected: 0 },
      );
      fits(out, width);
    }
  });

  it('fits the typing box, the confirmation and the empty screen too', () => {
    // Every state of the screen, not just the table. The text someone TYPES is
    // the most likely of all to run past the edge, because it grows keystroke
    // by keystroke while the frame stays the same size.
    const long = 'x'.repeat(200);
    const states = [
      { label: 'typing', options: { prompt: { label: 'new name:', text: long } } },
      { label: 'typing error', options: { prompt: { label: 'new name:', text: 'n', error: long } } },
      { label: 'confirming', options: { confirm: long } },
      { label: 'a notice', options: { notice: long } },
    ];
    for (const width of [92, 64, 40]) {
      for (const state of states) {
        const out = renderDashboard(snapshot([account({ name: 'work' })]), {
          color: false,
          width,
          interactive: true,
          ...state.options,
        });
        for (const line of out.split('\n')) {
          expect(line.length, `${state.label} at ${width}: ${line}`).toBeLessThanOrEqual(width);
        }
      }
      // Nothing added yet: the invitation to add one still has to fit.
      const empty = renderDashboard(snapshot([]), { color: false, width, interactive: true });
      for (const line of empty.split('\n')) {
        expect(line.length, `empty at ${width}: ${line}`).toBeLessThanOrEqual(width);
      }
      expect(empty).toContain('no accounts yet');
    }
  });
});

describe('renderDashboard (plain)', () => {
  const opts = { color: false as const, clock: utc };

  it('shows the title, header, and each account', () => {
    const out = renderDashboard(
      { ...snapshot([account({ name: 'work' }), account({ name: 'personal' })]), version: '2.4.0' },
      opts,
    );
    expect(out.split('\n')[0]).toMatch(/^ccx 2\.4\.0 /);
    expect(out).toContain('ACCOUNT');
    expect(rowOf(out, 'work')).toBeDefined();
    expect(rowOf(out, 'personal')).toBeDefined();
  });

  it('names the account priority where there is room to explain it', () => {
    // The table gave its width to the bars, so priority moved to the line that
    // describes the highlighted account.
    const out = renderDashboard(snapshot([account({ name: 'work', priority: 2 })]), {
      ...opts,
      interactive: true,
    });
    expect(out).toContain(' work (w@x.com · max · priority 2)');
  });

  it('says where a session goes when its account runs out, which the table cannot show', () => {
    // The one thing on this screen no other tool has: not the state, but what
    // the state is about to cause.
    const out = renderDashboard(
      { ...snapshot([account()]), whenOut: { account: 'phx', words: 'phx (80% of Fable left)' } },
      opts,
    );
    expect(out).toContain(' when one runs out → phx (80% of Fable left)');
  });

  it('says which model comes first beside the account new sessions start on, not a guess at the live one', () => {
    const out = renderDashboard(
      { ...snapshot([account({ name: 'a', active: true })]), model: 'claude-fable-5[1m]' },
      opts,
    );
    expect(out.split('\n')[0]).toMatch(/new sessions start on a · Fable first$/);
  });

  it('shows the rotation settings, and the keys that change them only when interactive', () => {
    const settings = { model: 'Opus, then Fable', order: 'longest run first' };
    const still = renderDashboard({ ...snapshot([account({ name: 'a' })]), settings }, opts);
    expect(still).toContain(' model: Opus, then Fable  ·  pick: longest run first');
    expect(still).not.toContain('s settings');
    const live = renderDashboard({ ...snapshot([account({ name: 'a' })]), settings }, { ...opts, interactive: true });
    expect(live).toContain(' s settings  ·  model: Opus, then Fable  ·  pick: longest run first');
  });

  it('leads the settings line with its key, so a narrow terminal cannot cut it off', () => {
    const settings = { model: 'Opus, then Fable', order: 'longest run first', holdBack: 'weeks 80%+ used' };
    const out = renderDashboard(
      { ...snapshot([account({ name: 'a' })]), settings },
      { ...opts, interactive: true, width: 60 },
    );
    const line = out.split('\n').find((l) => l.includes('model:')) ?? '';
    expect(line.startsWith(' s settings  ·  model:')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(60);
  });

  it('draws each hint key bright and what it does dim, so the keys stand out', () => {
    const out = renderDashboard(snapshot([account({ name: 'a' })]), { color: true, interactive: true });
    // ESC[1m is bold, ESC[2m dim: the key, then its action.
    expect(out).toContain('\u001b[1ms\u001b[0m\u001b[2m settings\u001b[0m');
    expect(out).toContain('\u001b[1mq/esc\u001b[0m\u001b[2m quit\u001b[0m');
  });

  it('names the key that removes an account beside the one that adds one', () => {
    const out = renderDashboard(snapshot([account({ name: 'a' })]), { color: false, interactive: true });
    expect(out).toContain('a add  ·  x remove  ·  l sign in');
  });

  it('still shows the remove key in a window as wide as the README pictures', () => {
    const out = renderDashboard(snapshot([account({ name: 'a' })]), { color: false, interactive: true, width: 116 });
    expect(out.split('\n').at(-1)).toContain('x remove');
  });

  it('says from how full a week accounts are held back, when they are', () => {
    const settings = { model: 'Opus only', order: 'longest run first', holdBack: 'weeks 80%+ used' };
    const out = renderDashboard({ ...snapshot([account({ name: 'a' })]), settings }, opts);
    expect(out).toContain('pick: longest run first  ·  held back: weeks 80%+ used');
  });

  it('says a held-back account is held back in its detail line', () => {
    const out = renderDashboard(
      snapshot([
        account({
          name: 'a',
          usage: { fiveHour: 0, sevenDay: 0.89 },
          pick: pick(5, { runway: 0.73, binding: 'weekly', heldBack: { weekLeft: 0.11 } }),
        }),
      ]),
      { ...opts, interactive: true, selected: 0 },
    );
    expect(out).toContain('pick #5 (held back: 11% of its week left), room for 73% of a 5-hour window (the week binds)');
  });

  it("says the highlighted account's place and room in its detail line", () => {
    const out = renderDashboard(
      snapshot([
        account({
          name: 'a',
          usage: { fiveHour: 0.6, sevenDay: 0.2 },
          pick: pick(1, { runway: 0.4, binding: '5-hour' }),
        }),
      ]),
      { ...opts, interactive: true, selected: 0 },
    );
    expect(out).toContain('pick #1, room for 40% of a 5-hour window');
  });

  it("spells out the highlighted account's model windows, which the table has no column for", () => {
    const out = renderDashboard(
      snapshot([
        account({
          name: 'work',
          usage: {
            fiveHour: 0.5,
            sevenDay: 0.62,
            fiveHourReset: NOW + 90 * MIN,
            sevenDayReset: NOW + 3 * DAY,
            models: [
              { name: 'Fable', utilization: 0.1, resetsAt: NOW + 2 * DAY },
              { name: 'Opus', utilization: 0.25 },
            ],
          },
        }),
      ]),
      { ...opts, interactive: true, selected: 0 },
    );
    const detail = out.split('\n').find((l) => l.startsWith(' work (')) ?? '';
    expect(detail).toContain('Fable 90% left, resets in 2d');
    expect(detail).toContain('Opus 75% left');
    // The row above it already says these, each beside its bar.
    expect(detail).not.toContain('5-hour');
    expect(detail).not.toContain('week');
  });

  it('says so plainly when an account has never been read', () => {
    const out = renderDashboard(snapshot([account({ name: 'fresh' })]), {
      ...opts,
      interactive: true,
      selected: 0,
    });
    expect(out).toContain('no usage read yet');
  });

  it('describes the row the cursor is on, in the order drawn', () => {
    const out = renderDashboard(machine(), { ...opts, width: 120, interactive: true, selected: 4 });
    expect(out.split('\n').some((l) => l.startsWith(' stephenalvi2 ('))).toBe(true);
  });

  it('shows key hints only in interactive mode, no footer for a one-shot frame', () => {
    expect(renderDashboard(snapshot([account()]), opts)).not.toContain('rotate');
    expect(renderDashboard(snapshot([account()]), opts)).not.toContain('refreshing');
    const footer = renderDashboard(snapshot([account()]), { color: false, interactive: true });
    expect(footer).toContain('r rotate');
    expect(footer).toContain('enter use'); // the activate-selected hint
    expect(footer).not.toContain('pin'); // the old misleading label is gone
  });

  it('rules the key hints off from what is above them', () => {
    const lines = renderDashboard(snapshot([account()]), { color: false, interactive: true }).split('\n');
    expect(lines.at(-2)).toMatch(/^─+$/);
    expect(lines.at(-1)).toContain('q/esc quit');
    // A one-shot frame has nothing below to rule off.
    expect(renderDashboard(snapshot([account()]), opts).split('\n').at(-1)).toMatch(/^─+$/);
  });
});

describe('renderDashboard (color)', () => {
  it('includes ANSI codes when color is on and none when off', () => {
    const withColor = renderDashboard(snapshot([account({ active: true })]), { color: true });
    const noColor = renderDashboard(snapshot([account({ active: true })]), { color: false });
    expect(withColor).toContain(ESC);
    expect(noColor).not.toContain(ESC);
  });

  it('colours a bar by how much is left: plenty green, spent red', () => {
    const out = renderDashboard(
      snapshot([account({ name: 'a', pick: pick(1), usage: { fiveHour: 0, sevenDay: 0.9 } })]),
      { color: true },
    );
    expect(out).toContain(`${ESC}[92m██████████${ESC}[0m`);
    expect(out).toContain(`${ESC}[31m█░░░░░░░░░${ESC}[0m`);
  });

  it('draws an account that is out in grey, with only its return standing out', () => {
    const out = renderDashboard(
      snapshot([account({ name: 'a', usage: { fiveHour: 0, sevenDay: 1, sevenDayReset: NOW + 2 * DAY } })]),
      { color: true },
    );
    expect(out).toContain(`${ESC}[2m██████████${ESC}[0m`);
    expect(out).toContain(`${ESC}[33mback in 2d${ESC}[0m`);
  });
});

describe('the sign-in question', () => {
  const opts = { color: false as const };
  const asked = 'Sign in "work" again? The dashboard steps aside while you do.';

  it('offers Y as the default, because Enter already confirms', () => {
    // confirmKey has always taken Enter as yes. The label said [y/N], which
    // advertises the opposite, so the quickest key looked like the wrong one
    // and every sign-in was answered by hunting for y.
    const out = renderDashboard(snapshot([account()]), { ...opts, confirm: asked });
    expect(out).toContain('[Y/n]');
    expect(out).not.toContain('[y/N]');
  });

  it('names Enter in the footer, so the default is discoverable without guessing', () => {
    const out = renderDashboard(snapshot([account()]), { ...opts, confirm: asked });
    expect(out).toContain('enter or y confirm');
    // The guard stays: l sits next to j and k, so a stray press must not sign
    // anything in just because the next keystroke happened to arrive.
    expect(out).toContain('any other key cancels');
  });
});

describe('the footer on a narrow terminal', () => {
  it('keeps the quit hint, whatever else it has to drop', () => {
    // The hints fall off the end rather than wrapping, so whichever one is
    // last to fit is the one lost. Losing "how do I get out of this" is the
    // one outcome that leaves somebody stuck, and naming esc made that hint
    // longer, so it must not sit behind hints you could have guessed.
    for (const width of [80, 60, 40, 30, 24]) {
      const out = renderDashboard(snapshot([account()]), {
        color: false,
        interactive: true,
        width,
      });
      expect(out, `width ${width}`).toContain('q/esc quit');
    }
  });
});

describe('the Claude Desktop line', () => {
  const desktop = { line: 'Desktop  on stephen, week spent for 4d 17h (past its plan) · 2 busy, 8 idle', keys: 'd moves by hand' };

  it('shows what Desktop is spending, and its keys only where keys work', () => {
    const still = renderDashboard({ ...snapshot([account()]), desktop }, { color: false });
    expect(still).toContain('Desktop  on stephen, week spent for 4d 17h (past its plan) · 2 busy, 8 idle');
    expect(still).not.toContain('d moves by hand');
    const live = renderDashboard({ ...snapshot([account()]), desktop }, { color: false, interactive: true });
    expect(live).toContain('d moves by hand');
  });

  it('is not there at all when Desktop is not in use', () => {
    expect(renderDashboard(snapshot([account()]), { color: false })).not.toContain('Desktop');
  });
});

describe('the settings panel', () => {
  const rows = [
    { group: 'Picking accounts', label: 'Pick the next account by', value: 'longest run first' },
    { group: 'Picking accounts', label: 'Hold back weeks used past', value: '80%' },
    { group: 'Models', label: 'Model preference', value: 'Opus, then Fable' },
    { group: 'Restarts', label: 'Restart prompt', value: 'This session was restarted.' },
  ];
  const panel = (selected: number) => ({
    rows,
    selected,
    help: 'What it does.',
    applies: "Takes effect at each session's next move.",
  });

  it('is drawn in place of the accounts, grouped, with the highlighted setting explained', () => {
    const out = renderDashboard(snapshot([account({ name: 'acct' })]), {
      color: false,
      interactive: true,
      panel: panel(1),
    });
    expect(out).not.toContain('ACCOUNT');
    expect(out).toContain('  Picking accounts');
    expect(out).toContain('   ▸ Hold back weeks used past   80%');
    expect(out).toContain('     Pick the next account by    longest run first');
    expect(out).toContain('  What it does.');
    expect(out).toContain("  Takes effect at each session's next move.");
    expect(out).toContain('s/esc back  ·  j/k move  ·  ←/→ change  ·  enter edit  ·  d default  ·  q quit');
  });

  it('carries the same title as the accounts it stands in for', () => {
    const out = renderDashboard(
      { ...snapshot([]), version: '2.4.0' },
      { color: false, interactive: true, panel: panel(0) },
    );
    expect(out.split('\n')[0]).toBe('ccx 2.4.0   settings');
  });

  it('never draws wider than the terminal, wrapping the explanation instead of cutting it', () => {
    const long = { ...panel(0), help: 'word '.repeat(40).trim() };
    for (const width of [100, 64, 40]) {
      const out = renderDashboard(snapshot([]), { color: false, interactive: true, panel: long, width });
      for (const line of out.split('\n')) expect(line.length, `at ${width}: ${line}`).toBeLessThanOrEqual(width);
    }
    const at64 = renderDashboard(snapshot([]), { color: false, interactive: true, panel: long, width: 64 });
    expect(at64.split('\n').filter((l) => l.startsWith('  word')).length).toBe(3);
  });

  it('scrolls to keep the highlighted setting on a short screen, rather than grow past it', () => {
    const out = renderDashboard(snapshot([]), { color: false, interactive: true, panel: panel(3), height: 12 });
    expect(out.split('\n').length).toBeLessThanOrEqual(12);
    expect(out).toContain('▸ Restart prompt');
    expect(out).not.toContain('Pick the next account by');
  });

  it('keeps the end of a long value being typed in view', () => {
    const typed = 'carry on with the migration and then run every test in the whole repository';
    const out = renderDashboard(snapshot([]), {
      color: false,
      interactive: true,
      panel: panel(3),
      width: 50,
      prompt: { label: 'Restart prompt:', text: typed },
    });
    const line = out.split('\n').find((l) => l.startsWith('  Restart prompt:')) ?? '';
    expect(line.endsWith('whole repository█')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(50);
  });

  it('gives a question wider than half the screen lines of its own, above the box', () => {
    const question = 'move which to "b"? 1 api (on a), 2 web (on a), 3 cli (on c); a for all; enter alone for none:';
    const out = renderDashboard(snapshot([account()]), {
      color: false,
      interactive: true,
      width: 60,
      prompt: { label: question, text: '1 3' },
    });
    const lines = out.split('\n');
    const box = lines.findIndex((l) => l === '  › 1 3█');
    expect(box).toBeGreaterThan(0);
    expect(lines[box - 2]).toBe('  move which to "b"? 1 api (on a), 2 web (on a), 3 cli (on');
    expect(lines[box - 1]).toBe('  c); a for all; enter alone for none:');
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(60);
  });
});
