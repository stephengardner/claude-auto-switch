import type { CliContext } from '../context.js';

/**
 * What a command that changes an account says: its sentence, or with `--json`
 * the same answer as values in the envelope every machine-readable output on
 * this CLI shares, so a program never parses the sentence.
 */
export function answer(
  context: CliContext,
  values: Record<string, unknown>,
  sentence: string,
): number {
  context.out(context.json ? JSON.stringify({ schemaVersion: 1, ...values }, null, 2) : sentence);
  return 0;
}

/** Why it did nothing, the same way: `{ schemaVersion, error }` with `--json`. Exit 1 either way. */
export function refuse(context: CliContext, why: string): number {
  context.out(context.json ? JSON.stringify({ schemaVersion: 1, error: why }, null, 2) : why);
  return 1;
}
