import { existsSync } from 'node:fs';
import path from 'node:path';
import { CREDENTIALS_FILE, readCredential } from '../accounts/credential-storage.js';
import { configFilePath, configStamp, loadConfig } from '../config/config.js';
import { DEFAULT_EXPIRY_MARGIN_MINUTES } from '../config/config.schema.js';
import type { PathCtx } from '../config/paths.js';

/**
 * A lent login: an access token that another machine, its owner, lent this one
 * (`ccx lend`), without the refresh token that renews it.
 *
 * A refresh token works once: renewing a login replaces it, and every other
 * copy of the old one stops working. A login copied whole to a second machine
 * therefore ends whichever copy renews second. A lent login cannot renew at
 * all, so it can never end its owner's: the owner renews it and sends the new
 * access token again before the old one runs out.
 *
 * Recognised by its content, so the copy a session keeps in its own folder is
 * recognised too: the `ccxLend` key beside `claudeAiOauth`, and no refresh
 * token. A sign-in made here afterwards brings a refresh token of its own, and
 * from then on the login is this machine's own, whatever else the file holds.
 */

/** The key a lent credential carries beside `claudeAiOauth`. */
export const LENT_MARKER = 'ccxLend';

/**
 * Written beside a lent login in its profile folder, holding nothing secret.
 * Asking whether an account is lent then costs one look at the folder rather
 * than a read of its login, which on macOS is a Keychain read: the dashboard
 * asks this of every account on every frame.
 */
export const LENT_HINT_FILE = '.ccx-lent';

export interface LentLogin {
  /** When its access token expires, epoch ms; 0 when it names no time. */
  expiresAt: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The lent login in a credential's text, or null when it is not one. Never throws. */
export function lentLoginFromText(text: string): LentLogin | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed[LENT_MARKER])) return null;
  const oauth = parsed.claudeAiOauth;
  if (!isPlainObject(oauth)) return null;
  if (typeof oauth.accessToken !== 'string' || oauth.accessToken.length === 0) return null;
  // A refresh token is a sign-in made here, so the login is this machine's own.
  if (typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0) return null;
  const at = oauth.expiresAt;
  return { expiresAt: typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : 0 };
}

/** The lent login in the profile folder `dir`, or null when it holds none. Never throws. */
export function lentLoginIn(dir: string): LentLogin | null {
  if (!existsSync(path.join(dir, LENT_HINT_FILE))) return null;
  try {
    return lentLoginFromText(readCredential(path.join(dir, CREDENTIALS_FILE)));
  } catch {
    return null;
  }
}

let marginCache: { key: string; ms: number } | null = null;

/**
 * `lending.expiryMarginMinutes`, in milliseconds. Read from config.json only
 * when the file has changed, because availability is asked often. A config
 * that does not load leaves the default: the margin must hold regardless.
 */
export function lendMarginMs(ctx: PathCtx = {}): number {
  const key = `${configFilePath(ctx)}\n${configStamp(ctx) ?? ''}`;
  if (marginCache?.key === key) return marginCache.ms;
  let minutes = DEFAULT_EXPIRY_MARGIN_MINUTES;
  try {
    minutes = loadConfig(ctx).lending?.expiryMarginMinutes ?? minutes;
  } catch {
    /* the default, as above */
  }
  marginCache = { key, ms: minutes * 60_000 };
  return marginCache.ms;
}

/** Whether a lent login can still be picked: more than `marginMs` is left on it. */
export function lendUsable(lent: LentLogin, marginMs: number, now: number): boolean {
  return lent.expiresAt - marginMs > now;
}

/**
 * Whether `dir` holds a lent login too close to its expiry to use, or past it.
 * Such an account waits for its owner to send a fresh one; nothing on this
 * machine can renew it. False for every login that is not lent.
 */
export function lendUnavailable(dir: string, ctx: PathCtx = {}, now: number = Date.now()): boolean {
  const lent = lentLoginIn(dir);
  return lent !== null && !lendUsable(lent, lendMarginMs(ctx), now);
}
