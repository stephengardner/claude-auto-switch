import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { credentialPath, sessionIdentityEmail } from './credential-vault.js';

/**
 * Confirm that each profile really holds the account it claims to.
 *
 * Local files cannot answer this: `claude auth status` reports the identity
 * recorded in the config, not the account the stored token actually belongs to,
 * so a profile can look correct while holding someone else's login. The only
 * authoritative check is to ask the API who a token belongs to.
 */

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const OAUTH_BETA = 'oauth-2025-04-20';

export interface IdentityFinding {
  account: string;
  /** The email the registry expects for this profile. */
  expected?: string;
  /** Who the stored token actually belongs to. */
  actual?: string;
  kind: 'ok' | 'mismatch' | 'duplicate' | 'logged-out' | 'unknown';
  detail: string;
}

export interface CheckableAccount {
  name: string;
  dir: string;
  email?: string;
}

/**
 * Ask the API which account the credential stored in `dir` belongs to. This is
 * the only authoritative answer: local files report the identity a profile has
 * recorded, which can already be wrong.
 */
export async function fetchTokenOwner(
  dir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const token = accessTokenOf(dir);
  return token ? whoAmI(token, fetchImpl) : null;
}

function accessTokenOf(dir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(credentialPath(dir), 'utf8')) as {
      claudeAiOauth?: { accessToken?: string };
    };
    const token = parsed.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Ask the API which account a token belongs to. */
async function whoAmI(token: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(PROFILE_URL, {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { account?: { email_address?: string; email?: string } };
    return data.account?.email_address ?? data.account?.email ?? null;
  } catch {
    return null;
  }
}

/**
 * Check every profile: is it logged in, does its token belong to the expected
 * account, and are two profiles on the same account? Sequential on purpose, to
 * stay friendly to the endpoint.
 *
 * Scope: this reports duplicate OWNERSHIP only. Whether renewing one profile
 * would destroy another's login is a different question, answered by comparing
 * refresh tokens in duplicate-guard, because two profiles can reach one account
 * through separate logins.
 */
export async function verifyAccountIdentities(
  accounts: CheckableAccount[],
  fetchImpl: typeof fetch = fetch,
): Promise<IdentityFinding[]> {
  const findings: IdentityFinding[] = [];
  const fingerprints = new Map<string, string>(); // token hash -> first profile seen

  for (const account of accounts) {
    // What this profile is supposed to be: the address recorded at registration
    // if there is one, otherwise the address the profile itself claims.
    const expected = account.email ?? sessionIdentityEmail(account.dir) ?? undefined;
    const token = accessTokenOf(account.dir);
    if (!token) {
      findings.push({
        account: account.name,
        ...(expected ? { expected } : {}),
        kind: 'logged-out',
        detail: `no stored login (run: ccx login ${account.name})`,
      });
      continue;
    }

    const fingerprint = createHash('sha256').update(token).digest('hex');
    const twin = fingerprints.get(fingerprint);
    if (twin) {
      findings.push({
        account: account.name,
        kind: 'duplicate',
        detail: `is the same ACCOUNT as "${twin}", so switching between them gains nothing (run: ccx login ${account.name})`,
      });
      continue;
    }
    fingerprints.set(fingerprint, account.name);

    const actual = await whoAmI(token, fetchImpl);
    if (!actual) {
      findings.push({
        account: account.name,
        ...(expected ? { expected } : {}),
        kind: 'unknown',
        detail: 'could not confirm the account (offline, or the token was rejected)',
      });
      continue;
    }
    if (expected && expected.toLowerCase() !== actual.toLowerCase()) {
      findings.push({
        account: account.name,
        expected,
        actual,
        kind: 'mismatch',
        detail: `holds ${actual}, but this profile is ${expected} (run: ccx login ${account.name})`,
      });
      continue;
    }
    findings.push({ account: account.name, actual, kind: 'ok', detail: actual });
  }

  // Two profiles signed into the SAME account is a problem even when each looks
  // correct on its own: it happens when one profile is re-pointed at another's
  // account, which rewrites what it claims about itself so nothing looks wrong.
  // It also means rotating between them gains no headroom at all.
  const byOwner = new Map<string, string[]>();
  for (const f of findings) {
    if (f.kind !== 'ok' || !f.actual) continue;
    const key = f.actual.toLowerCase();
    byOwner.set(key, [...(byOwner.get(key) ?? []), f.account]);
  }
  for (const [owner, names] of byOwner) {
    if (names.length < 2) continue;
    for (const name of names.slice(1)) {
      const finding = findings.find((f) => f.account === name);
      if (!finding) continue;
      finding.kind = 'duplicate';
      finding.detail = `is the same ACCOUNT as "${names[0]}" (${owner}), so switching between them gains nothing (run: ccx login ${name})`;
    }
  }
  return findings;
}
