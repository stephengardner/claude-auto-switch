import path from 'node:path';
import { InvalidNameError } from './errors.js';

/** Windows reserved device names that cannot be used as folder names. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Validate an account name before it is ever used to build a filesystem path.
 * Account names become folder names under the profiles dir, so a name with
 * separators or `..` would escape the sandbox (and later feed `rmSync --purge`).
 * We reject rather than sanitize: only a conservative charset is allowed.
 */
export function assertProfileName(name: string): void {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new InvalidNameError(
      `invalid account name "${name}": use 1-64 chars of letters, digits, dot, dash, underscore`,
    );
  }
  if (name === '.' || name === '..' || name.startsWith('-')) {
    throw new InvalidNameError(`invalid account name "${name}"`);
  }
  if (WINDOWS_RESERVED.test(name)) {
    throw new InvalidNameError(`account name "${name}" is a reserved device name`);
  }
}

/** True when `child` resolves to a path strictly inside `parent`. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Assert a directory is strictly inside the profiles root. Used before any
 * destructive operation (recursive delete) so a stray `--dir` or crafted
 * registry entry can never target a path outside the tool's own tree.
 */
export function assertInsideProfiles(profilesRoot: string, dir: string): void {
  if (!isInside(profilesRoot, dir)) {
    throw new InvalidNameError(
      `refusing to operate on "${dir}": it is outside the profiles directory (${profilesRoot})`,
    );
  }
}
