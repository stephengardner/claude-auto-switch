/**
 * Regenerate the screenshots in the README.
 *
 * These are drawn by the SAME renderers the tool uses on screen, given a set of
 * invented accounts, and written as SVG rather than a bitmap so they stay sharp
 * at any size, diff as text, and can be redone whenever the output changes
 * instead of rotting quietly.
 *
 * The renderers are imported from the build and handed data directly, rather
 * than the commands being run: the commands would reach the network and shell
 * out to Claude to read account health, which a screenshot script has no
 * business doing. What is drawn is real output; only the numbers are invented.
 *
 * Nothing here can show a real account. Every name, address and number below is
 * made up.
 *
 *   npm run build && node scripts/screenshots.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderUsageReport } from '../dist/usage/report.js';
import { renderDashboard } from '../dist/dashboard/render.js';
import { describeWhenOut } from '../dist/dashboard/next-up.js';
import { inDisplayOrder } from '../dist/dashboard/arrange.js';
import {
  modelUsageFor,
  numberPicks,
  pickAside,
  rankAccounts,
  settingsWords,
} from '../dist/dashboard/rotation-settings.js';
import { SETTINGS, appliesWords, valueOf } from '../dist/dashboard/settings-catalog.js';
import { ConfigSchema } from '../dist/config/config.schema.js';
import { standingOf } from '../dist/usage/runway.js';

const OUT_DIR = path.join('docs', 'img');
/**
 * A wide terminal, so every bar is drawn at full width. A narrower picture
 * shows the shape the dashboard takes when it is squeezed, which is not what
 * anyone sees first.
 */
const COLS = 140;
const NOW = Date.UTC(2026, 0, 15, 9, 30);
const mins = (n) => NOW + n * 60_000;
const FIVE_HOUR_RESET = mins(88);
const WEEK_RESET = mins(60 * 86);
const FABLE_RESET = mins(60 * 48);

/** Invented accounts, chosen to show the states worth understanding. */
const ACCOUNTS = [
  {
    name: 'work',
    email: 'work@example.com',
    plan: 'max',
    active: true,
    // In use, and its 5-hour window is spent: the line under the table shows the move.
    five: 1,
    week: 0.41,
    fable: 0.05,
  },
  {
    // A verified account: no 5-hour limit at all, only its week. Its week
    // resets sooner than the others', so its budget is the one to use first.
    name: 'ultra',
    email: 'ultra@example.com',
    plan: 'max',
    active: false,
    noFive: true,
    week: 0.31,
    weekReset: mins(60 * 31),
    fable: 0,
  },
  {
    // Fine overall, but one model is spent: the distinction ccx exists to make.
    name: 'personal',
    email: 'personal@example.com',
    plan: 'max',
    active: false,
    five: 0,
    week: 0.68,
    fable: 1,
  },
  {
    name: 'spare',
    email: 'spare@example.com',
    plan: 'max',
    active: false,
    // Tagged: kept for a bot, which the row says first.
    tags: ['bot'],
    five: 0.12,
    week: 0.03,
    fable: 0,
  },
  {
    // A fresh 5-hour window on a week nearly spent: held back, so it comes
    // after every healthy account, however fresh that window is.
    name: 'old',
    email: 'old@example.com',
    plan: 'pro',
    active: false,
    five: 0,
    week: 0.89,
    fable: 0.2,
  },
];

const weekResetOf = (a) => a.weekReset ?? WEEK_RESET;

const windowsFor = (a) => [
  a.noFive
    ? { label: '5-hour', used: null, resetsAt: null, none: true }
    : { label: '5-hour', used: a.five, resetsAt: FIVE_HOUR_RESET },
  { label: 'weekly', used: a.week, resetsAt: weekResetOf(a) },
  { label: 'Fable', used: a.fable, resetsAt: FABLE_RESET, modelOnly: true },
];

const usageAnsi = renderUsageReport(
  ACCOUNTS.map((a) => ({
    name: a.name,
    email: a.email,
    plan: a.plan,
    active: a.active,
    windows: windowsFor(a),
  })),
  NOW,
  { color: true, width: 100 },
);

// Ranked, numbered and explained by the same functions the dashboard uses, over
// these same invented numbers, so the picture cannot drift from the tool.
const PREFERENCE = ['opus', 'fable'];
const usageOf = (name) => {
  const a = ACCOUNTS.find((x) => x.name === name);
  return {
    fiveHour: a.noFive ? null : a.five,
    sevenDay: a.week,
    fiveHourReset: a.noFive ? null : FIVE_HOUR_RESET,
    sevenDayReset: weekResetOf(a),
    models: [{ name: 'Fable', utilization: a.fable, resetsAt: FABLE_RESET }],
    ...(a.noFive ? { noFiveHourLimit: true } : {}),
  };
};
const POLICY = { accountOrder: 'smart', holdBackAtPercent: 80 };
const ranked = rankAccounts(
  ACCOUNTS.map((a, i) => ({ name: a.name, priority: i, enabled: true })),
  usageOf,
  POLICY,
  'opus',
  NOW,
);
const candidates = ranked.map((a) => modelUsageFor(a.name, usageOf(a.name), [], NOW));
const standing = (name) => standingOf(usageOf(name), NOW, 'opus', POLICY.holdBackAtPercent);
const picks = numberPicks(candidates, PREFERENCE, true, standing);

const dashboardAccounts = [
  ...ACCOUNTS.map((a, i) => ({
    name: a.name,
    email: a.email,
    plan: a.plan,
    loggedIn: true,
    active: a.active,
    enabled: true,
    priority: i,
    usage: usageOf(a.name),
    ...(a.tags ? { tags: a.tags } : {}),
    ...(picks.has(a.name) ? { pick: picks.get(a.name) } : {}),
  })),
  // Out of rotation, for the two reasons an account can be: signed out, and
  // put on hold by Anthropic, which signing in again does not fix. Only the
  // dashboard shows them; `ccx usage` has no numbers to show for either.
  {
    name: 'laptop',
    email: 'laptop@example.com',
    plan: 'pro',
    loggedIn: false,
    active: false,
    enabled: true,
    priority: ACCOUNTS.length,
    tags: ['pat'],
  },
  {
    name: 'trial',
    email: 'trial@example.com',
    plan: 'max',
    loggedIn: false,
    onHold: true,
    active: false,
    enabled: true,
    priority: ACCOUNTS.length + 1,
  },
];
// Clock times read in UTC here, so the picture is the same on every machine.
// The dashboard itself reads them in the local zone.
const utcClock = (epochMs) => {
  const at = new Date(epochMs);
  const hour = at.getUTCHours();
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(at.getUTCMinutes()).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
};
// The cursor sits on the verified account, so the line that explains a row
// says what having no 5-hour limit means. Rows are counted in the order the
// dashboard draws them.
const HIGHLIGHTED = inDisplayOrder(dashboardAccounts, 'opus', NOW).findIndex(
  (a) => a.name === 'ultra',
);

const dashboardAnsi = renderDashboard(
  {
    accounts: dashboardAccounts,
    events: [
      '08:41  session on work',
      '09:12  saved to your settings.json: permissions.allow',
      '09:26  sessions prefer Opus, then Fable, from their next start or move',
    ],
    now: NOW,
    refreshMs: 3000,
    model: 'opus',
    version: '2.6.32',
    whenOut: describeWhenOut({
      candidates,
      current: ACCOUNTS.find((a) => a.active)?.name ?? null,
      modelInUse: 'opus',
      preference: PREFERENCE,
      strategy: 'model-first',
      reasonFor: (name) => pickAside(standing(name), NOW),
    }),
    settings: settingsWords({ modelPreference: PREFERENCE, ...POLICY }),
    sessions: [
      { number: 1, where: 'api', account: 'work' },
      { number: 2, where: 'web', account: 'work' },
      { number: 3, where: 'docs', account: 'spare' },
    ],
  },
  { color: true, interactive: true, selected: HIGHLIGHTED, width: COLS, clock: utcClock },
);

// The settings panel over the defaults, with the hold-back highlighted.
const DEFAULTS = ConfigSchema.parse({});
const HIGHLIGHT = SETTINGS.findIndex((s) => s.key === 'rotation.holdBackAtPercent');
const settingsAnsi = renderDashboard(
  { accounts: [], events: [], now: NOW, refreshMs: 3000 },
  {
    color: true,
    interactive: true,
    width: 116,
    panel: {
      rows: SETTINGS.map((s) => ({
        group: s.group,
        label: s.label,
        value: s.words(valueOf(DEFAULTS, s.key)),
      })),
      selected: HIGHLIGHT,
      help: SETTINGS[HIGHLIGHT].help,
      applies: appliesWords(SETTINGS[HIGHLIGHT].applies),
    },
  },
);

// --- ANSI to SVG ----------------------------------------------------------
// Only the codes these renderers emit, so the mapping stays readable and there
// is no dependency to keep current.

const PALETTE = {
  31: '#e06c75',
  32: '#98c379',
  33: '#e5c07b',
  34: '#61afef',
  35: '#c678dd',
  36: '#56b6c2',
  37: '#dcdfe4',
  91: '#ff7b86',
  92: '#b6e3a1',
  93: '#f5d98b',
  94: '#82c6ff',
  95: '#dd9bf0',
  96: '#79d4dd',
};
const FG = '#dcdfe4';
const BG = '#1b1e24';
const DIM = 0.55;

/** Split ANSI text into lines of cells: one character each, with its style. */
function parseAnsi(text) {
  const lines = [];
  let style = { color: FG, bold: false, dim: false };
  let cells = [];
  const clean = text.split('\r').join('');
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (ch === '\x1b' && clean[i + 1] === '[') {
      const end = clean.indexOf('m', i);
      if (end === -1) break;
      for (const part of clean.slice(i + 2, end).split(';')) {
        const code = Number(part || '0');
        if (code === 0) style = { color: FG, bold: false, dim: false };
        else if (code === 1) style = { ...style, bold: true };
        else if (code === 2) style = { ...style, dim: true };
        else if (PALETTE[code]) style = { ...style, color: PALETTE[code] };
      }
      i = end;
      continue;
    }
    if (ch === '\n') {
      lines.push(cells);
      cells = [];
      continue;
    }
    cells.push({ ch, ...style });
  }
  if (cells.length) lines.push(cells);
  return lines;
}

const escapeXml = (s) =>
  s
    .split('&')
    .join('&amp;')
    .split('<')
    .join('&lt;')
    .split('>')
    .join('&gt;')
    .split('"')
    .join('&quot;');

const isBar = (ch) => ch === '█' || ch === '░';
const sameStyle = (a, b) => a.color === b.color && a.bold === b.bold && a.dim === b.dim;

/**
 * A terminal window, drawn as SVG.
 *
 * Every cell sits on a fixed grid. Text is drawn in runs pinned to the width
 * its cells take (`textLength`), so a column starts where it does on a
 * terminal whatever font the reader's machine falls back to; a bar is drawn
 * as a track with its filled part over it rather than as block characters,
 * which most fonts draw taller than a line and a little apart; and a rule is
 * a line.
 */
function toSvg(ansi, title) {
  const lines = parseAnsi(ansi);
  const CHAR_W = 8.4;
  const LINE_H = 22;
  const PAD_X = 24;
  const PAD_TOP = 56; // room for the title bar
  const PAD_BOTTOM = 18;
  // Sized to the widest line actually drawn, not to the width the renderer was
  // given: the dashboard's key hints are longer than its table, and a fixed
  // width left them hanging outside the window frame.
  const widest = lines.reduce((max, cells) => Math.max(max, cells.length), 0);
  const width = Math.ceil(PAD_X * 2 + widest * CHAR_W);
  const height = PAD_TOP + lines.length * LINE_H + PAD_BOTTOM;
  const x = (col) => (PAD_X + col * CHAR_W).toFixed(1);

  const shapes = [];
  lines.forEach((cells, row) => {
    const y = PAD_TOP + row * LINE_H;
    let col = 0;
    while (col < cells.length) {
      const cell = cells[col];
      // A bar: the whole run of block characters, a track under a filled part.
      if (isBar(cell.ch)) {
        let end = col;
        while (end < cells.length && isBar(cells[end].ch)) end += 1;
        const barY = (y - 11).toFixed(1);
        shapes.push(
          `<rect x="${x(col)}" y="${barY}" width="${((end - col) * CHAR_W - 2).toFixed(1)}" height="12" rx="2.5" fill="${FG}" opacity="0.12"/>`,
        );
        let fill = col;
        while (fill < end && cells[fill].ch === '█') fill += 1;
        if (fill > col) {
          const on = cells[col];
          shapes.push(
            `<rect x="${x(col)}" y="${barY}" width="${((fill - col) * CHAR_W - 2).toFixed(1)}" height="12" rx="2.5" fill="${on.color}"${on.dim ? ` opacity="${DIM}"` : ''}/>`,
          );
        }
        col = end;
        continue;
      }
      // A rule: a line through the middle of its cells.
      if (cell.ch === '─') {
        let end = col;
        while (end < cells.length && cells[end].ch === '─') end += 1;
        shapes.push(
          `<rect x="${x(col)}" y="${(y - 5).toFixed(1)}" width="${((end - col) * CHAR_W).toFixed(1)}" height="1" fill="${FG}" opacity="0.22"/>`,
        );
        col = end;
        continue;
      }
      // Text: as long a run as shares one style, pinned to its cells.
      let end = col;
      while (
        end < cells.length &&
        !isBar(cells[end].ch) &&
        cells[end].ch !== '─' &&
        sameStyle(cells[end], cell)
      ) {
        end += 1;
      }
      const text = cells
        .slice(col, end)
        .map((c) => c.ch)
        .join('');
      const lead = text.length - text.trimStart().length;
      const body = text.trim();
      if (body) {
        const at = col + lead;
        const weight = cell.bold ? ' font-weight="700"' : '';
        const opacity = cell.dim ? ` opacity="${DIM}"` : '';
        shapes.push(
          `<text x="${x(at)}" y="${y}" fill="${cell.color}"${weight}${opacity} textLength="${(body.length * CHAR_W).toFixed(1)}" lengthAdjust="spacingAndGlyphs" xml:space="preserve">${escapeXml(body)}</text>`,
        );
      }
      col = end;
    }
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, 'Cascadia Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="14">
  <rect width="${width}" height="${height}" rx="12" fill="${BG}"/>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="none" stroke="#ffffff" stroke-opacity="0.08"/>
  <path d="M0 12a12 12 0 0 1 12-12h${width - 24}a12 12 0 0 1 12 12v22H0z" fill="#23272f"/>
  <rect y="33" width="${width}" height="1" fill="#000000" opacity="0.35"/>
  <circle cx="22" cy="17" r="6" fill="#ec6a5f"/>
  <circle cx="42" cy="17" r="6" fill="#f4bf50"/>
  <circle cx="62" cy="17" r="6" fill="#61c454"/>
  <text x="${width / 2}" y="21.5" fill="#8b93a1" font-size="12" text-anchor="middle">${escapeXml(title)}</text>
  ${shapes.join('\n  ')}
</svg>
`;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [file, ansi, title] of [
  ['usage.svg', usageAnsi, 'ccx usage'],
  ['dashboard.svg', dashboardAnsi, 'ccx dashboard'],
  ['settings.svg', settingsAnsi, 'ccx dashboard: settings (s)'],
]) {
  writeFileSync(path.join(OUT_DIR, file), toSvg(ansi, title), 'utf8');
  console.log(`${file.padEnd(15)} ${String(parseAnsi(ansi).length).padStart(3)} lines`);
}
console.log(`\nwritten to ${OUT_DIR}/`);
