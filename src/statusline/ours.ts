/**
 * Telling ccx's status line apart from anyone else's.
 *
 * Its own module because both the installer and the session settings ask it,
 * and the installer already depends on the session code; sharing it from either
 * of them would make the two import each other.
 */

export const CCX_COMMAND = 'ccx statusline';

/**
 * Anchored on purpose. A command like `echo ccx statusline` is the user's, and
 * a substring search would claim it: `ccx on` would replace it and `ccx off`
 * would delete it.
 */
const OURS = /^ccx statusline(?:\s|$)/;

/** True when this value is a status line ccx installed (wrapped or not). */
export function isOurs(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const command = (value as { command?: unknown }).command;
  return typeof command === 'string' && OURS.test(command.trim());
}
