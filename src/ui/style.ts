/**
 * Shared terminal styling, so every ccx screen looks like the same tool.
 * Colour is opt-in per call: callers pass whether the output is a real terminal,
 * which keeps piped output clean and testable.
 */

const ESC = String.fromCharCode(27);

export const codes = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  red: `${ESC}[31m`,
  cyan: `${ESC}[36m`,
  magenta: `${ESC}[35m`,
  brightGreen: `${ESC}[92m`,
  brightYellow: `${ESC}[93m`,
  brightRed: `${ESC}[91m`,
  brightCyan: `${ESC}[96m`,
};

/**
 * Colour on a scale from plenty to spent.
 *
 * Deliberately four bands rather than "dim until it is nearly gone". Everything
 * below 90 percent used to render the same shade of grey, which made a page of
 * numbers read as one flat block and hid the difference between an account at 5
 * percent and one at 85.
 */
export function shadeForUsed(used: number | null): string {
  if (used === null) return codes.dim;
  if (used >= 1) return codes.brightRed;
  if (used >= 0.85) return codes.red;
  if (used >= 0.6) return codes.brightYellow;
  return codes.brightGreen;
}

/** Wrap `text` in an ANSI code when colour is on. */
export function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${codes.reset}` : text;
}

/** A dim horizontal rule of the given width. */
export function rule(width: number, color: boolean): string {
  return paint('─'.repeat(Math.max(1, width)), codes.dim, color);
}
