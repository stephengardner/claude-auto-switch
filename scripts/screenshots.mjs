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
const COLS = 116;
const NOW = Date.UTC(2026, 0, 15, 9, 30);
const mins = (n) => NOW + n * 60_000;

/** Invented accounts, chosen to show the states worth understanding. */
const ACCOUNTS = [
  {
    name: 'work',
    email: 'work@example.com',
    plan: 'max',
    active: true,
    // In use, and its 5-hour window is spent: the next line shows the move.
    five: 1,
    week: 0.41,
    fable: 0.05,
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

const windowsFor = (a) => [
  { label: '5-hour', used: a.five, resetsAt: mins(88) },
  { label: 'weekly', used: a.week, resetsAt: mins(60 * 86) },
  { label: 'Fable', used: a.fable, resetsAt: mins(60 * 48), modelOnly: true },
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
  { color: true, width: COLS },
);

// Ranked, numbered and explained by the same functions the dashboard uses, over
// these same invented numbers, so the picture cannot drift from the tool.
const PREFERENCE = ['opus', 'fable'];
const usageOf = (name) => {
  const a = ACCOUNTS.find((x) => x.name === name);
  return {
    fiveHour: a.five,
    sevenDay: a.week,
    fiveHourReset: mins(88),
    sevenDayReset: mins(60 * 86),
    models: [{ name: 'Fable', utilization: a.fable, resetsAt: mins(60 * 48) }],
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

const dashboardAccounts = ACCOUNTS.map((a, i) => ({
  name: a.name,
  email: a.email,
  plan: a.plan,
  loggedIn: true,
  active: a.active,
  enabled: true,
  priority: i,
  usage: usageOf(a.name),
  ...(picks.has(a.name) ? { pick: picks.get(a.name) } : {}),
}));
// Clock times read in UTC here, so the picture is the same on every machine.
// The dashboard itself reads them in the local zone.
const utcClock = (epochMs) => {
  const at = new Date(epochMs);
  const hour = at.getUTCHours();
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(at.getUTCMinutes()).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
};
// The cursor sits on the held-back account, so the line that explains a row
// is shown explaining the one that most needs it. Rows are counted in the
// order the dashboard draws them.
const HIGHLIGHTED = inDisplayOrder(dashboardAccounts, 'opus', NOW).findIndex((a) => a.name === 'old');

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
      { number: 2, where: 'web', account: 'spare' },
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
    width: COLS,
    panel: {
      rows: SETTINGS.map((s) => ({ group: s.group, label: s.label, value: s.words(valueOf(DEFAULTS, s.key)) })),
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

/** Split ANSI text into styled runs, one list of runs per line. */
function parseAnsi(text) {
  const lines = [];
  let style = { color: FG, bold: false, dim: false };
  let runs = [];
  let buf = '';
  const flush = () => {
    if (buf) runs.push({ text: buf, ...style });
    buf = '';
  };
  const clean = text.split('\r').join('');
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (ch === '\x1b' && clean[i + 1] === '[') {
      const end = clean.indexOf('m', i);
      if (end === -1) break;
      flush();
      for (const part of clean.slice(i + 2, end).split(';')) {
        const code = Number(part || '0');
        if (code === 0) style = { color: FG, bold: false, dim: false };
        else if (code === 1) style.bold = true;
        else if (code === 2) style.dim = true;
        else if (PALETTE[code]) style.color = PALETTE[code];
      }
      i = end;
      continue;
    }
    if (ch === '\n') {
      flush();
      lines.push(runs);
      runs = [];
      continue;
    }
    buf += ch;
  }
  flush();
  if (runs.length) lines.push(runs);
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

/** A terminal window, drawn as SVG. */
function toSvg(ansi, title) {
  const lines = parseAnsi(ansi);
  const CHAR_W = 8.4;
  const LINE_H = 21;
  const PAD_X = 22;
  const PAD_TOP = 52; // room for the title bar
  const PAD_BOTTOM = 20;
  // Sized to the widest line actually drawn, not to the width the renderer was
  // given: the dashboard's key hints are longer than its table, and a fixed
  // width left them hanging outside the window frame.
  const widest = lines.reduce(
    (max, runs) =>
      Math.max(
        max,
        runs.reduce((n, r) => n + [...r.text].length, 0),
      ),
    0,
  );
  const width = Math.ceil(PAD_X * 2 + widest * CHAR_W) + 4; // a few px so nothing clips
  const height = PAD_TOP + lines.length * LINE_H + PAD_BOTTOM;

  const body = lines
    .map((runs, row) => {
      const y = PAD_TOP + row * LINE_H;
      let col = 0;
      return runs
        .map((run) => {
          const x = PAD_X + col * CHAR_W;
          col += [...run.text].length;
          if (!run.text.trim()) return '';
          const weight = run.bold ? ' font-weight="600"' : '';
          const opacity = run.dim ? ' opacity="0.6"' : '';
          return `<text x="${x.toFixed(1)}" y="${y}" fill="${run.color}"${weight}${opacity} xml:space="preserve">${escapeXml(run.text)}</text>`;
        })
        .join('');
    })
    .join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="14">
  <rect width="${width}" height="${height}" rx="10" fill="${BG}"/>
  <rect width="${width}" height="32" rx="10" fill="#22262e"/>
  <rect y="22" width="${width}" height="10" fill="#22262e"/>
  <circle cx="21" cy="16" r="5.5" fill="#ec6a5f"/>
  <circle cx="40" cy="16" r="5.5" fill="#f4bf50"/>
  <circle cx="59" cy="16" r="5.5" fill="#61c454"/>
  <text x="${width / 2}" y="20.5" fill="#8b93a1" font-size="12" text-anchor="middle">${escapeXml(title)}</text>
  ${body}
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
