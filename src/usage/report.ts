import { windowIsOpen, effectiveUtilization, bindsHarder } from './window-open.js';
import { codes, paint, shadeForUsed } from '../ui/style.js';

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
  /**
   * The stored login has been rejected for good, so this account cannot work
   * however much room it has. Passed in rather than looked up here, because
   * this renderer stays pure and testable on its own.
   */
  needsSignIn?: boolean;
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

/** Plenty of room reads green, tight reads amber, spent reads red. */
const shade = shadeForUsed;

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
  if (hours < 24) return `${hours}h ${String(mins % 60).padStart(2, '0')}m`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

/**
 * How much of a window is used RIGHT NOW.
 *
 * Three states, and conflating any two of them produces a wrong report:
 *
 * - nothing measured: null, and null is not zero
 * - measured, but the window has since reset: the recorded number describes a
 *   limit that has ended, so it constrains nothing now
 * - measured and still open: the number stands
 *
 * The middle case is positive information, not missing information. A window
 * that reset began again at empty, which is why it counts as room rather than
 * as an unknown.
 */
export function effectiveUsed(w: UsageWindow, now: number): number | null {
  return effectiveUtilization(w.used, w.resetsAt, now);
}

/**
 * Whether anything at all has been measured for these windows.
 *
 * Deliberately independent of whether any window is still in force: an account
 * whose limits have all reset HAS been read, and reporting "nothing read yet"
 * for it would be false.
 */
export function hasReading(windows: UsageWindow[] | null | undefined): boolean {
  return (windows ?? []).some((w) => typeof w.used === 'number');
}

/**
 * The window closest to its limit: the one that will actually stop you. An
 * average across windows hides exactly this, which is the number that matters.
 *
 * Judged on usage as it stands now, so a window that has reset sinks to the
 * bottom instead of being reported as the constraint.
 */
export function bindingWindow(windows: UsageWindow[], now: number): UsageWindow | null {
  const known = windows.filter((w) => typeof w.used === 'number');
  if (known.length === 0) return null;
  // Ties go to a window that is still open; see bindsHarder.
  return known.reduce((worst, w) => (bindsHarder(w, worst, now) ? w : worst));
}

/**
 * The tightest window that applies to the WHOLE account, ignoring per-model
 * ones. This is the "can I work here at all" question: a spent model window
 * stops that model, not the account.
 */
export function accountWideBinding(windows: UsageWindow[], now: number): UsageWindow | null {
  return bindingWindow(windows.filter((w) => !w.modelOnly), now);
}

/**
 * Where there is room, most room first, judged on account-wide windows only.
 * Judging on every window would hide an account that is perfectly usable and
 * merely out of one model, which is the common case.
 */
export function roomiest(accounts: UsageAccount[], now: number): UsageAccount[] {
  // Room is worth nothing on an account that cannot sign in, and this answers
  // "where should I go right now". Recommending one is worse than the rotation
  // equivalent: rotation tries it and recovers, while advice just sends someone
  // to a session that fails with no explanation.
  const usable = accounts.filter((a) => !a.needsSignIn);
  const used = (a: UsageAccount): number | null => {
    if (!a.windows) return null;
    const binding = accountWideBinding(a.windows, now);
    return binding ? effectiveUsed(binding, now) : null;
  };
  return usable
    // An account whose account-wide limit has RESET belongs here: its window
    // began again at empty, so it is somewhere to go. Only an account nobody
    // has read is left out, because that is a genuine unknown.
    .filter((a) => used(a) !== null)
    .filter((a) => (used(a) ?? 1) < 1)
    .sort((x, y) => (used(x) ?? 1) - (used(y) ?? 1));
}

/**
 * The used part carries the colour and the remainder stays dim, so how full a
 * window is can be read without stopping to look at the number.
 */
function paintBar(used: number | null, size: number, color: boolean): string {
  const drawn = bar(used, size);
  if (!color || used === null) return paint(drawn, codes.dim, color);
  const filled = drawn.replace(/░+$/u, '');
  const empty = drawn.slice(filled.length);
  return paint(filled, shade(used), color) + paint(empty, codes.dim, color);
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
    const signIn = account.needsSignIn
      ? `  ${paint('NEEDS SIGN-IN', `${codes.bold}${codes.yellow}`, color)}`
      : '';
    lines.push(
      (account.active
        ? `${paint(heading, `${codes.bold}${codes.cyan}`, color)}  ${paint('ACTIVE', codes.cyan, color)}`
        : paint(heading, codes.bold, color)) + signIn,
    );

    if (!account.windows) {
      lines.push(paint('    no usage read yet', codes.dim, color));
      lines.push('');
      continue;
    }

    for (const w of account.windows) {
      const wait = humanWait(w.resetsAt, now);
      // What the bar and percentage show is usage as it stands now, so a window
      // that has reset reads as empty rather than staying at the number it hit
      // before it rolled over.
      const shown = effectiveUsed(w, now);
      const lifted = typeof w.used === 'number' && !windowIsOpen(w.resetsAt, now);
      const spent = shown !== null && shown >= 1;
      const tail = spent
        ? paint(wait ? `SPENT, back in ${wait}` : 'SPENT', `${codes.bold}${codes.brightRed}`, color)
        : lifted
          ? // Said plainly, because the number we last read was high and the row
            // now shows empty: this explains why.
            paint('reset since it was last read', codes.dim, color)
          : wait
            ? paint(`back in ${wait}`, codes.dim, color)
            : '';
      lines.push(
        `    ${paint(w.label.padEnd(labelW), codes.cyan, color)}  ${paintBar(shown, barSize, color)} ` +
          `${paint(percent(shown), shade(shown), color)}   ${tail}`.trimEnd(),
      );
    }

    const binding = bindingWindow(account.windows, now);
    if (binding) {
      const spentNow = (effectiveUsed(binding, now) ?? 0) >= 1;
      const note = spentNow
        ? binding.modelOnly
          ? `${binding.label} is spent; other models still work on this account`
          : `${binding.label} is spent, so this account cannot work until it resets`
        : `${binding.label} is closest to its limit at ${percent(effectiveUsed(binding, now)).trim()}`;
      lines.push(paint(`    -> ${note}`, codes.dim, color));
    }
    lines.push('');
  }

  const best = roomiest(accounts, now);
  // Whether usage was READ, which is a different question from whether any
  // limit is currently in force. An account whose windows have all reset has
  // been read, and saying otherwise sends the operator looking for a fault.
  const anythingRead = accounts.some((a) => hasReading(a.windows));
  // Ranking is decided on account-wide windows alone, so a run that read only
  // per-model numbers has nothing to rank. Without this, such a run falls
  // through to the "everything is spent" line and reports a limit that was
  // never read, sending the operator to look up reset times that do not exist.
  const accountWideRead = accounts.some((a) =>
    hasReading((a.windows ?? []).filter((w) => !w.modelOnly)),
  );
  if (!anythingRead) {
    lines.push(
      paint('No usage has been read yet, so there is nothing to compare.', codes.dim, color),
    );
  } else if (!accountWideRead) {
    lines.push(
      paint(
        'Only per-model usage has been read, so there is nothing to compare account by account.',
        codes.dim,
        color,
      ),
    );
  } else if (best.length === 0 && accounts.some((a) => a.needsSignIn)) {
    // Distinct from being out of room, and the distinction is the whole point:
    // waiting for a reset never fixes a login, so saying "check the reset times"
    // would send the operator away to wait for something that cannot happen.
    const stale = accounts.filter((a) => a.needsSignIn).map((a) => a.name);
    lines.push(
      paint(
        `These accounts need signing in again: ${stale.join(', ')}. Run: ccx login ${stale[0]}`,
        codes.yellow,
        color,
      ),
    );
  } else if (best.length === 0) {
    lines.push(
      paint('Every account has hit an account-wide limit. Check the reset times above.', codes.yellow, color),
    );
  } else {
    const top = best[0] as UsageAccount;
    const binding = accountWideBinding(top.windows as UsageWindow[], now);
    lines.push(
      paint('Most room right now: ', codes.dim, color) +
        paint(top.name, `${codes.bold}${codes.brightGreen}`, color) +
        paint(
          binding
            ? `  (${binding.label} at ${percent(effectiveUsed(binding, now)).trim()}, its tightest)`
            : '',
          codes.dim,
          color,
        ),
    );
  }
  return lines.join('\n');
}
