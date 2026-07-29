import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { copySecretFile } from '../util/secret-file.js';

/**
 * Credential storage with a safety net.
 *
 * Every write of a credential file keeps the PREVIOUS one alongside it, so a
 * bad swap (or a token that turns out to be dead) can always be rolled back
 * instead of leaving an account permanently logged out. Combined with the
 * identity check below, this is what stops two profiles from silently ending up
 * on one login, and what stops a killed refresh from destroying a good account.
 */

export const CREDENTIALS_FILE = '.credentials.json';
const PREVIOUS_FILE = '.credentials.prev.json';

export function credentialPath(dir: string): string {
  return path.join(dir, CREDENTIALS_FILE);
}

export function previousCredentialPath(dir: string): string {
  return path.join(dir, PREVIOUS_FILE);
}

/** True when the file holds a non-empty JSON object (a plausible credential). */
export function isUsableCredential(file: string): boolean {
  try {
    const text = readFileSync(file, 'utf8');
    if (text.trim().length === 0) return false;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

/**
 * A stable identity fingerprint for a config dir's `.claude.json` (account uuid /
 * email / org), or null when it carries no identity. Used to notice that a
 * session became a DIFFERENT account (an interactive `/login`), which must never
 * be written back over the profile it started from.
 */
export function identityKey(configDir: string): string | null {
  try {
    const cfg = JSON.parse(readFileSync(path.join(configDir, '.claude.json'), 'utf8')) as {
      oauthAccount?: Record<string, unknown>;
    };
    const oauth = cfg.oauthAccount;
    if (!oauth) return null;
    const parts = ['accountUuid', 'emailAddress', 'organizationUuid']
      .map((k) => (typeof oauth[k] === 'string' ? (oauth[k] as string) : ''))
      .filter((v) => v.length > 0);
    return parts.length > 0 ? parts.join('|') : null;
  } catch {
    return null;
  }
}

/**
 * Install `sourceFile` as `dir`'s credential, keeping the existing one as the
 * previous generation. Refuses to install an unusable (empty/corrupt) source,
 * because overwriting a good login with garbage is the worst outcome.
 * Returns false when nothing was installed.
 */
export function installCredential(dir: string, sourceFile: string): boolean {
  if (!isUsableCredential(sourceFile)) return false;
  const target = credentialPath(dir);
  if (existsSync(target) && isUsableCredential(target)) {
    try {
      copySecretFile(target, previousCredentialPath(dir));
    } catch {
      /* the backup is a cushion, not a precondition */
    }
  }
  copySecretFile(sourceFile, target);
  return true;
}

/**
 * Restore the previous generation (used when a swap fails part-way). Returns
 * false when there is no usable backup to restore.
 */
export function rollbackCredential(dir: string): boolean {
  const prev = previousCredentialPath(dir);
  if (!isUsableCredential(prev)) return false;
  copySecretFile(prev, credentialPath(dir));
  return true;
}

/** Remove a config dir's live credential (used to scrub a shared session dir). */
export function clearCredential(dir: string): void {
  try {
    rmSync(credentialPath(dir), { force: true });
  } catch {
    /* best effort */
  }
}
