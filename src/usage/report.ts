import { codes, paint } from '../ui/style.js';

/**
 * The full usage picture for every account, written to be read at a glance.
 *
 * The old output was one cramped table with the reset times on a second line,
 * which made the thing you actually want to know ("can I work, and where")
 * something you had to work out yourself. This shows every window per account
 * with a bar, says which one is the binding constraint, and ends with where to
 * go right now.
 */

export interface UsageWindow {
  label: string;
  used: number | null;
  resetsAt: number | null;
  /**
   * True for a window that covers ONE model rather than the whole account.
   * The difference matters: a spent model window stops that model, not the
   * account, and saying otherwise sends you away from an account you could
   * still work on by switching model.
   */
  modelOnly?: boolean;
}

export interface UsageAccount {
  name: string;
  email?: string | undefined;
  plan?: string | undefined;
  active: boolean;
  /** Null when nothing has been read for this account yet. */
  windows: UsageWindow[] | null;
}

export interface ReportOptions {
  color?: boolean;
  /** Terminal width, so the bars fit rather than wrapping. */
  width?: number;
}

const BAR_MIN = 10;
const BAR_MAX = 24;

/** Full when spent, and never rounds a non-zero sliver down to empty. */
export function bar(used: number | null, size: number): string {
  if (used === null) return '-'.repeat(size);
  const clamped = Math.max(0, Math.min(1, used));
  let filled = Math.round(clamped * size);
  if (clamped > 0 && filled === 0) filled = 1;
  if (clamped < 1 && filled === size) filled = size - 1;
  return '█'.repeat(filled) + '░'.repeat(size - filled);
}

/** Spent is red, nearly spent amber, otherwise plain. */
function shade(used: number | null): string {
  if (used === null) return codes.dim;
  if (used >= 1) return codes.red;
  if (used >= 0.9) return codes.yellow;
  return codes.dim;
}

export function percent(used: number | null): string {
  return used === null ? '  ?' : `${Math.round(used * 100)}%`.padStart(4);
}

/**
 * A wait at the coarsest useful precision. Weekly windows are days away, and
 * printing those in hours is technically right and unreadable.
 */
export function humanWait(resetsAt: number | null, now: number): string {
  if (resetsAt === null || resetsAt <= now) return '';
  const mins = Math.round((resetsAt - now) / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${String(mins % 60).padStart(2, '0')}m`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days}d` : `${days}d${rest}h`;
}

/**
 * The window closest to its limit: the one that will actually stop you. An
 * average across windows hides exactly this, which is the number that matters.
 */
export function bindingWindow(windows: UsageWindow[]): UsageWindow | null {
  const known = windows.filter((w) => typeof w.used === 'number');
  if (known.length === 0) return null;
  return known.reduce((worst, w) => ((w.used ?? 0) > (worst.used ?? 0) ? w : worst));
}

/**
 * The tightest window that applies to the WHOLE account, ignoring per-model
 * ones. This is the "can I work here at all" question: a spent model window
 * stops that model, not the account.
 */
export function accountWideBinding(windows: UsageWindow[]): UsageWindow | null {
  return bindingWindow(windows.filter((w) => !w.modelOnly));
}

/**
 * Where there is room, most room first, judged on account-wide windows only.
 * Judging on every window would hide an account that is perfectly usable and
 * merely out of one model, which is the common case.
 */
export function roomiest(accounts: UsageAccount[]): UsageAccount[] {
  return accounts
    .filter((a) => a.windows && accountWideBinding(a.windows))
    .filter((a) => (accountWideBinding(a.windows as UsageWindow[])?.used ?? 1) < 1)
    .sort((x, y) => {
      const bx = accountWideBinding(x.windows as UsageWindow[])?.used ?? 1;
      const by = accountWideBinding(y.windows as UsageWindow[])?.used ?? 1;
      return bx - by;
    });
}

export function renderUsageReport(
  accounts: UsageAccount[],
  now: number,
  options: ReportOptions = {},
): string {
  const color = options.color ?? true;
  const width = options.width ?? 100;
  const labelW = Math.max(
    ...accounts.flatMap((a) => (a.windows ?? []).map((w) => w.label.length)),
    7,
  );
  const barSize = Math.max(BAR_MIN, Math.min(BAR_MAX, width - labelW - 34));
  const lines: string[] = [];

  for (const account of accounts) {
    const bits = [account.name];
    if (account.email) bits.push(account.email);
    if (account.plan) bits.push(account.plan);
    const heading = bits.join('  ·  ');
    lines.push(
      account.active
        ? `${paint(heading, `${codes.bold}${codes.cyan}`, color)}  ${paint('ACTIVE', codes.cyan, color)}`
        : paint(heading, codes.bold, color),
    );

    if (!account.windows) {
      lines.push(paint('    no usage read yet', codes.dim, color));
      lines.push('');
      continue;
    }

    for (const w of account.windows) {
      const wait = humanWait(w.resetsAt, now);
      const spent = w.used !== null && w.used >= 1;
      const tail = spent
        ? paint(wait ? `SPENT, back in ${wait}` : 'SPENT', codes.red, color)
        : wait
          ? paint(`back in ${wait}`, codes.dim, color)
          : '';
      lines.push(
        `    ${w.label.padEnd(labelW)}  ${paint(bar(w.used, barSize), shade(w.used), color)} ` +
          `${paint(percent(w.used), shade(w.used), color)}   ${tail}`.trimEnd(),
      );
    }

    const binding = bindingWindow(account.windows);
    if (binding) {
      const spentNow = (binding.used ?? 0) >= 1;
      const note = spentNow
        ? binding.modelOnly
          ? `${binding.label} is spent; other models still work on this account`
          : `${binding.label} is spent, so this account cannot work until it resets`
        : `${binding.label} is closest to its limit at ${percent(binding.used).trim()}`;
      lines.push(paint(`    -> ${note}`, codes.dim, color));
    }
    lines.push('');
  }

  const best = roomiest(accounts);
  if (best.length === 0) {
    lines.push(
      paint('Every account has hit an account-wide limit. Check the reset times above.', codes.yellow, color),
    );
  } else {
    const top = best[0] as UsageAccount;
    const binding = accountWideBinding(top.windows as UsageWindow[]);
    lines.push(
      paint('Most room right now: ', codes.dim, color) +
        paint(top.name, codes.bold, color) +
        paint(
          binding ? `  (${binding.label} at ${percent(binding.used).trim()}, its tightest)` : '',
          codes.dim,
          color,
        ),
    );
  }
  return lines.join('\n');
}
