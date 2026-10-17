export type RunClassification = 'ok' | 'capped' | 'error';

export interface RunOutcome {
  exitCode: number;
  stderr: string;
  stdout?: string;
}

export interface CapClassification {
  kind: RunClassification;
  /** Extracted reset time (epoch ms) when the signal provided a parseable one. */
  resetAt?: number;
  reason?: string;
}

/**
 * Lines that MEASURE a limit rather than announce hitting one.
 *
 * Claude keeps a usage gauge on screen: "You've used 74% of your weekly limit,
 * resets Aug 12". That is the opposite of a cap, and it is present during a
 * perfectly healthy session, but it contains the words "weekly limit" and so it
 * matched. Every session therefore looked like it had capped, over and over.
 *
 * The consequence was not just noise. The trigger sent ccx to the usage API,
 * which answered "yes, limited" for an unrelated reason (one model's window was
 * spent), and ccx rotated a session that was running fine, eventually reporting
 * that every account had hit its limit while sitting on one with 92% of its
 * five-hour window free.
 *
 * These are REMOVED from the text before looking for a cap, rather than used to
 * reject the whole chunk, because a real cap message and the gauge can arrive in
 * the same screenful and the real one must still be found.
 */
// Bounded at the limit word (plus its resets clause), never to the end of the
// line: a REAL announcement can share the line with the gauge, and a pattern
// that ate everything to the next period removed the announcement with it.
// "You've used 74% of your weekly limit, Claude usage limit reached." became
// whitespace, and a genuine cap went unconfirmed.
//
// The separator class is built from escapes (middle dot, en dash, em dash)
// because the gauge renders with any of them before "resets".
const GAUGE_SEPARATORS = `[,\\u00b7\\u2013\\u2014\\-\\s]*`;
// The reset value stops at the first comma, period or newline, and is bounded
// in length. An open-ended tail re-created the same bug one clause later:
// "resets 2026-08-12T15:00:00Z, Claude usage limit reached" lost the
// announcement to the resets clause.
const RESETS_CLAUSE = `(?:${GAUGE_SEPARATORS}resets[^,.\\n]{0,60})?`;
const GAUGE_TAIL = `(?:\\s+of\\s+your\\s+[^.\\n]{0,40}?limit)?${RESETS_CLAUSE}`;
const GAUGE_PATTERNS = [
  // "You've used 74% of your weekly limit · resets Aug 12"
  new RegExp(`you'?ve used\\s+\\d+%${GAUGE_TAIL}`, 'gi'),
  new RegExp(`\\d+%\\s+of\\s+your\\s+[^.\\n]{0,40}?limit${RESETS_CLAUSE}`, 'gi'),
  // A warning that one is coming is not one arriving.
  /approaching\s+[^.\n]{0,40}?limit/gi,
  // The hint Claude 2.1.302 can end a gauge line with, its only use of these
  // phrases: "... · resets Oct 22, 1pm (America/New_York) · /usage-credits to
  // keep using Claude Code". The resets clause stops at the comma in a date,
  // so without this the hint is left behind, and it names /usage-credits.
  /(?:run\s+)?\/usage-credits\s+to\s+(?:keep using claude code|turn on extra usage for your org|ask your admin for more|raise the cap)/gi,
];

/**
 * Claude 2.1.302's words for limits that leave the account working, removed
 * like the gauges so a real announcement beside one is still found.
 *
 * Fast mode has a limit of its own. At it Claude sends the same request again
 * at standard speed, so the turn goes on, and an account that is out says so
 * in its own words on that retry. Its notification, the /fast picker and the
 * line for usage credits stopping fast mode are about fast mode only.
 *
 * "You've hit your monthly limit" is the usage-credits panel, which says the
 * credits' own monthly limit is reached when it is opened; it never comes with
 * a refused turn, which brings its own "You've hit your ..." line.
 */
const NOT_THE_ACCOUNT_PATTERNS = [
  // "Fast limit reached and temporarily disabled · resets in 4m 12s"
  new RegExp(`fast limit reached and temporarily disabled${RESETS_CLAUSE}`, 'gi'),
  // "You've hit your fast limit · resets in 4m 12s"
  new RegExp(`you'?ve hit your fast limit${RESETS_CLAUSE}`, 'gi'),
  // "Fast mode disabled · usage credit limit reached", or "· usage credits exhausted"
  new RegExp(`fast mode disabled${GAUGE_SEPARATORS}usage credits?\\b[^\\u00b7.\\n]{0,40}`, 'gi'),
  /you'?ve hit your monthly limit\b/gi,
];

const NON_CAP_PATTERNS = [...GAUGE_PATTERNS, ...NOT_THE_ACCOUNT_PATTERNS];

/**
 * Strip the gauge lines, and the limits that leave the account working, so
 * only a real announcement can match.
 */
function withoutNonCaps(text: string): string {
  return NON_CAP_PATTERNS.reduce((acc, re) => acc.replace(re, ' '), text);
}

/**
 * Patterns that indicate a usage cap. These cover the known phrasings; the exact
 * message the current CLI emits should be confirmed against a real cap and added
 * here if different. Detection is deliberately isolated so tightening it touches
 * only this file (spec 9).
 */
const CAP_PATTERNS = [
  // Confirmed live wording (per-model cap): "You've reached your Fable 5 limit.
  // Run /usage-credits to continue or switch models with /model."
  /reached your .{0,40}limit/i,
  /you'?ve reached your/i,
  /\/usage-credits/i,
  /switch models with \/model/i,
  // Claude 2.1.302 says every limit of the account's own as "You've hit your
  // <limit><details>": "You've hit your session limit · resets 6pm", "You've
  // hit your limit · resets 9pm", "You've hit your monthly spend limit · raise
  // it at <url> · your session limit resets 6pm", "You've hit your team's
  // shared budget". It records such a turn as usage_limit_reached.
  /you'?ve hit your [^.\n]{0,40}?\b(?:limit|budget)\b/i,
  // Other known phrasings.
  /usage limit reached/i,
  /rate ?limit/i,
  /rate[- ]?limited/i,
  /too many requests/i,
  /\blimit reached\b/i,
  /5[- ]hour limit/i,
  /weekly limit/i,
  /quota (?:exceeded|reached)/i,
];

/** Classify a completed run as ok, capped (rate-limited), or a generic error. */
export function classifyRun(outcome: RunOutcome): CapClassification {
  if (outcome.exitCode === 0) return { kind: 'ok' };

  const combined = `${outcome.stderr}\n${outcome.stdout ?? ''}`;
  const text = withoutNonCaps(combined);
  if (CAP_PATTERNS.some((re) => re.test(text))) {
    // From the ORIGINAL text, not the filtered one: the gauge filter can
    // remove the very timestamp the resets clause carried, and a cap that
    // shares a line with the gauge would then record no reset at all.
    const resetAt = extractResetAt(combined);
    // The reason comes from whichever stream actually carries the cap, and
    // from the LINE that matched: the raw first line can be the gauge, an
    // unrelated warning, or the wrong stream entirely, and each of those has
    // been recorded as "the reason" at some point.
    const filteredErr = withoutNonCaps(outcome.stderr);
    const filteredOut = withoutNonCaps(outcome.stdout ?? '');
    const source = CAP_PATTERNS.some((re) => re.test(filteredErr)) ? filteredErr : filteredOut;
    return {
      kind: 'capped',
      reason: capLine(source) ?? (firstNonEmptyLine(source) || 'usage cap'),
      ...(resetAt !== undefined ? { resetAt } : {}),
    };
  }

  return { kind: 'error', reason: firstLine(outcome.stderr) || `exit ${outcome.exitCode}` };
}

/**
 * Match the rate-limit signal in a live output STREAM for the PTY watcher. ANSI
 * escape codes are stripped first so the words still match inside the TUI render.
 */
export function matchesCapText(text: string): CapClassification | null {
  const plain = stripAnsi(text);
  const clean = withoutNonCaps(plain);
  if (!CAP_PATTERNS.some((re) => re.test(clean))) return null;
  // The unfiltered text, for the same reason as classifyRun: the gauge filter
  // can take the reset timestamp with it.
  const resetAt = extractResetAt(plain);
  return { kind: 'capped', reason: 'usage cap', ...(resetAt !== undefined ? { resetAt } : {}) };
}

/** Remove ANSI CSI escape sequences (ESC built at runtime to avoid a control-char literal). */
function stripAnsi(s: string): string {
  const csi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, 'g');
  return s.replace(csi, '');
}

/** Pull an ISO-8601 reset timestamp out of the message when one is present. */
function extractResetAt(text: string): number | undefined {
  const iso = text.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?\b/);
  if (iso) {
    const t = Date.parse(iso[0]);
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
}

/**
 * The reset time a refusal names, when it names one. Read from a refusal the
 * conversation's record already identified, so nothing here decides WHETHER it
 * was one.
 */
export function resetAtIn(text: string): number | undefined {
  return extractResetAt(text);
}

function firstLine(s: string): string {
  return s.split(/\r?\n/)[0]?.trim() ?? '';
}

/** The line the cap actually announced itself on, or null when none matches alone. */
function capLine(s: string): string | null {
  for (const line of s.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && CAP_PATTERNS.some((re) => re.test(trimmed))) return trimmed;
  }
  return null;
}

/** The first line with anything on it, for text the gauge filter has thinned. */
function firstNonEmptyLine(s: string): string {
  const leftovers = new RegExp(`^[\\s\\u00b7\\u2013\\u2014,\\-]+|\\s+$`, 'g');
  for (const line of s.split(/\r?\n/)) {
    const trimmed = line.replace(leftovers, '');
    // Something readable, not punctuation the filter left behind: a gauge that
    // ended in a period leaves "." on its line, and "." is no reason.
    if (/[a-z0-9]/i.test(trimmed)) return trimmed;
  }
  return '';
}
