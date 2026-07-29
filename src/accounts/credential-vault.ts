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

/**
 * True when the file actually carries a login, not merely the right shape.
 *
 * This distinction matters: when a session is logged out (or a token refresh
 * fails) Claude leaves a complete, valid-JSON credential whose token strings are
 * EMPTY. Treating that as a credential and saving it back over a stored account
 * destroys that login, which is exactly how an account here ended up with empty
 * tokens and no way back.
 *
 * Unrecognised shapes are accepted when they carry any non-empty value, so a
 * future change to Claude's credential format cannot make ccx refuse everything.
 */
export function isUsableCredential(file: string): boolean {
  try {
    const text = readFileSync(file, 'utf8');
    if (text.trim().length === 0) return false;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) return false;

    const oauth = parsed.claudeAiOauth as { accessToken?: unknown } | undefined;
    if (oauth && typeof oauth === 'object') {
      // Known shape: it is a login only if there is an access token in it.
      return typeof oauth.accessToken === 'string' && oauth.accessToken.length > 0;
    }
    if (typeof parsed.primaryApiKey === 'string' && parsed.primaryApiKey.length > 0) return true;
    return hasNonEmptyValue(parsed);
  } catch {
    return false;
  }
}

/**
 * The email a config dir is currently signed in as, or null. Claude keeps this
 * current for the session it is running, which makes it the reliable answer to
 * "who is this session actually logged in as right now".
 */
export function sessionIdentityEmail(configDir: string): string | null {
  try {
    const cfg = JSON.parse(readFileSync(path.join(configDir, '.claude.json'), 'utf8')) as {
      oauthAccount?: { emailAddress?: unknown };
    };
    const email = cfg.oauthAccount?.emailAddress;
    return typeof email === 'string' && email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

/** Any non-empty string/number anywhere in the object (forward compatibility). */
function hasNonEmptyValue(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return true;
  if (Array.isArray(value)) return value.some((v) => hasNonEmptyValue(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) => hasNonEmptyValue(v, depth + 1));
  }
  return false;
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
