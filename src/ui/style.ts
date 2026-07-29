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
};

/** Wrap `text` in an ANSI code when colour is on. */
export function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${codes.reset}` : text;
}

/** A dim horizontal rule of the given width. */
export function rule(width: number, color: boolean): string {
  return paint('─'.repeat(Math.max(1, width)), codes.dim, color);
}
