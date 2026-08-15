import { readFileSync } from 'node:fs';

/**
 * Which build of ccx this is.
 *
 * Read once from the package manifest rather than written down anywhere, so it
 * cannot drift from what was actually published, and cached because it is
 * stamped onto every log line.
 */

let cached: string | null = null;

export function ccxVersion(): string {
  if (cached !== null) return cached;
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown };
    cached = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    // A build that cannot read its own manifest still has to run and still has
    // to log; "unknown" is a worse answer than a number and a better one than
    // a crash in the logger.
    cached = 'unknown';
  }
  return cached;
}
