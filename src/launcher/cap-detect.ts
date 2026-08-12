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
const GAUGE_TAIL =
  `(?:\\s+of\\s+your\\s+[^.\\n]{0,40}?limit)?` + `(?:${GAUGE_SEPARATORS}resets[^.\\n]*)?`;
const GAUGE_PATTERNS = [
  // "You've used 74% of your weekly limit · resets Aug 12"
  new RegExp(`you'?ve used\\s+\\d+%${GAUGE_TAIL}`, 'gi'),
  new RegExp(`\\d+%\\s+of\\s+your\\s+[^.\\n]{0,40}?limit(?:${GAUGE_SEPARATORS}resets[^.\\n]*)?`, 'gi'),
  // A warning that one is coming is not one arriving.
  /approaching\s+[^.\n]{0,40}?limit/gi,
];

/** Strip the gauge lines so only a real announcement can match. */
function withoutGauges(text: string): string {
  return GAUGE_PATTERNS.reduce((acc, re) => acc.replace(re, ' '), text);
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

  const text = withoutGauges(`${outcome.stderr}\n${outcome.stdout ?? ''}`);
  if (CAP_PATTERNS.some((re) => re.test(text))) {
    const resetAt = extractResetAt(text);
    return {
      kind: 'capped',
      // From the FILTERED text: when the gauge precedes the announcement, the
      // raw first line is the gauge, and the recorded reason then says "74% of
      // your weekly limit" about an account that actually hit a real cap.
      reason: firstNonEmptyLine(withoutGauges(outcome.stderr)) || 'usage cap',
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
  const clean = withoutGauges(stripAnsi(text));
  if (!CAP_PATTERNS.some((re) => re.test(clean))) return null;
  const resetAt = extractResetAt(clean);
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

function firstLine(s: string): string {
  return s.split(/\r?\n/)[0]?.trim() ?? '';
}

/** The first line with anything on it, for text the gauge filter has thinned. */
function firstNonEmptyLine(s: string): string {
  const leftovers = new RegExp(`^[\\s\\u00b7\\u2013\\u2014,\\-]+|\\s+$`, 'g');
  for (const line of s.split(/\r?\n/)) {
    const trimmed = line.replace(leftovers, '');
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}
