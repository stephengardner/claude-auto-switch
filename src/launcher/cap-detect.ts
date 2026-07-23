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

  const text = `${outcome.stderr}\n${outcome.stdout ?? ''}`;
  if (CAP_PATTERNS.some((re) => re.test(text))) {
    const resetAt = extractResetAt(text);
    return {
      kind: 'capped',
      reason: firstLine(outcome.stderr) || 'usage cap',
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
  const clean = stripAnsi(text);
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
