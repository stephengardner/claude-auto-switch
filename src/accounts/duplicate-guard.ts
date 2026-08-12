import { readFileSync } from 'node:fs';
import { sha256Fingerprint } from '../util/fingerprint.js';
import { credentialPath } from './credential-vault.js';

/**
 * Stopping two profiles from holding the same account.
 *
 * This is worth preventing rather than detecting, because the damage is not just
 * cosmetic. Renewing a login ROTATES it: the old token stops working the moment
 * the new one is issued. So when two profiles share a login, renewing either one
 * destroys the other, and the account cannot be recovered without signing in
 * again. That is how two accounts here ended up dead.
 *
 * The state is also useless even before it breaks: switching between two
 * profiles that are the same account gains no extra room at all.
 */

export interface ProfileLike {
  name: string;
  dir: string;
  /**
   * The account this profile is registered FOR. Two profiles holding one token
   * are only siblings when this agrees; see `sameRegisteredAccount`.
   */
  email?: string;
}

/**
 * Are two profiles registered as the same Anthropic account?
 *
 * Unknown on either side means "cannot rule it out", which keeps the case this
 * whole file exists for working: signing in twice while the browser is still
 * signed in gives one account two profiles, and those really do have to be kept
 * in step.
 */
function sameRegisteredAccount(one: ProfileLike, other: ProfileLike): boolean {
  const a = (one.email ?? '').trim().toLowerCase();
  const b = (other.email ?? '').trim().toLowerCase();
  if (a.length === 0 || b.length === 0) return true;
  return a === b;
}

/** A short, comparable fingerprint of a token, so tokens never get logged. */
const fingerprint = (token: string): string => sha256Fingerprint(token);

interface Tokens {
  access?: string;
  refresh?: string;
}

function tokensOf(dir: string): Tokens {
  try {
    const parsed = JSON.parse(readFileSync(credentialPath(dir), 'utf8')) as {
      claudeAiOauth?: { accessToken?: string; refreshToken?: string };
    };
    const oauth = parsed.claudeAiOauth ?? {};
    return {
      ...(typeof oauth.accessToken === 'string' && oauth.accessToken.length > 0
        ? { access: fingerprint(oauth.accessToken) }
        : {}),
      ...(typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0
        ? { refresh: fingerprint(oauth.refreshToken) }
        : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Profiles that share a login with another profile, grouped together.
 *
 * Sharing a REFRESH token is the dangerous one: renewing any member of the group
 * invalidates the rest. Sharing only an access token is the same account reached
 * by two different logins, which is wasteful but not destructive.
 */
export function sharedLoginGroups(profiles: ProfileLike[]): Array<{ fingerprint: string; names: string[] }> {
  const byRefresh = new Map<string, string[]>();
  for (const profile of profiles) {
    const { refresh } = tokensOf(profile.dir);
    if (!refresh) continue;
    byRefresh.set(refresh, [...(byRefresh.get(refresh) ?? []), profile.name]);
  }
  return [...byRefresh.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([fp, names]) => ({ fingerprint: fp, names }));
}

/**
 * Would renewing this profile's login also invalidate another profile's?
 *
 * Matching tokens alone is NOT enough to answer yes. Callers use this list to
 * decide who a renewal gets carried across to, and carrying it to a profile
 * registered for a DIFFERENT account is what turned a one-off mix-up into a
 * permanent one: from the moment two profiles held one token, every renewal
 * copied the new token over the other, so they could never come apart, and
 * signing in again was undone by the next renewal minutes later. Three accounts
 * here spent a day as one, reporting one account's usage under three names and
 * refusing to rotate between them.
 *
 * Same token plus different registered accounts is contamination. The fix for
 * that is `ccx login <name>`, which `ccx doctor` already prints, not a copy.
 */
export function renewalWouldBreakOthers(profile: ProfileLike, profiles: ProfileLike[]): string[] {
  const { refresh } = tokensOf(profile.dir);
  if (!refresh) return [];
  return profiles
    .filter(
      (other) =>
        other.name !== profile.name &&
        tokensOf(other.dir).refresh === refresh &&
        sameRegisteredAccount(profile, other),
    )
    .map((other) => other.name);
}

/**
 * Does another profile already hold `email`? Compared case-insensitively,
 * because an address that differs only in case is the same account.
 */
export function profileAlreadyHolding(
  email: string,
  profiles: Array<ProfileLike & { email?: string }>,
  exclude: string,
): string | null {
  const wanted = email.trim().toLowerCase();
  if (wanted.length === 0) return null;
  const match = profiles.find(
    (p) => p.name !== exclude && (p.email ?? '').trim().toLowerCase() === wanted,
  );
  return match ? match.name : null;
}
