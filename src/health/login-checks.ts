import path from 'node:path';
import { statSync } from 'node:fs';
import { z } from 'zod';
import { configHome, type PathCtx } from '../config/paths.js';
import { readJsonFile } from '../util/fs-json.js';
import { writeSecretFile } from '../util/secret-file.js';
import { credentialPath } from '../accounts/credential-vault.js';
import { probe, type ProbeableAccount, type ProberDeps, type ProbeResult } from './prober.js';

/**
 * The login checks ccx made, remembered, so a read that can use one a little
 * old does not ask Claude about every account again.
 *
 * A check is `claude auth status` run on an account's folder, a whole Claude
 * start each time, and it is most of what one `ccx state` costs: 48.75 s of
 * wall time and 8 to 18 s of CPU for 17 accounts, measured on 2026-11-07, run
 * in parallel. A program reading the state every minute was paying that every
 * minute for answers that had not changed.
 *
 * So the reads a program or a person makes to look remember what they found
 * (the dashboard, which checks again every 20 s while it is open, `ccx state`,
 * `ccx list` and `ccx status`; a session start, `ccx rotate` and `ccx doctor`
 * ask afresh and leave no record), and `ccx state --cached-logins <seconds>` uses a remembered
 * check no older than that instead of asking again. A check is used only for
 * the same account in the same folder, never when its login file has changed
 * since (a sign-in, a renewal), and never when it failed to read. A login with
 * no file to watch (one kept in the macOS Keychain) is bounded by the age
 * alone. Each account in the state says when its check was made, so a reader
 * always knows how old what it is reading is.
 *
 * What the check found is not the whole answer either way: a login the token
 * endpoint refused afterwards is still taken away (health/signed-in), from
 * ccx's own records, on every read.
 */

const FILENAME = 'login-checks.json';

const CheckSchema = z
  .object({
    dir: z.string(),
    checkedAt: z.number(),
    loggedIn: z.boolean(),
    email: z.string().optional(),
    orgName: z.string().optional(),
    plan: z.string().optional(),
  })
  .passthrough();
const ChecksSchema = z.object({ checks: z.record(z.string(), CheckSchema) }).passthrough();
type Checks = z.infer<typeof ChecksSchema>;

function checksPath(c: PathCtx): string {
  return path.join(configHome(c), FILENAME);
}

function readChecks(c: PathCtx): Checks {
  try {
    return readJsonFile(checksPath(c), ChecksSchema) ?? { checks: {} };
  } catch {
    return { checks: {} };
  }
}

/**
 * Remember these checks, for the accounts given (an account no longer
 * registered is forgotten). A check that could not be read is not
 * remembered: it says nothing about the login. Best effort; owner-only, since
 * a check names the account's email, as the account registry does.
 */
export function rememberChecks(
  results: readonly ProbeResult[],
  accounts: readonly ProbeableAccount[],
  c: PathCtx,
): void {
  try {
    const known = readChecks(c).checks;
    const checks: Checks['checks'] = {};
    for (const account of accounts) {
      const result = results.find((r) => r.name === account.name);
      if (result && result.error === undefined) {
        checks[account.name] = {
          dir: account.dir,
          checkedAt: result.checkedAt,
          loggedIn: result.loggedIn,
          ...(result.email !== undefined ? { email: result.email } : {}),
          ...(result.orgName !== undefined ? { orgName: result.orgName } : {}),
          ...(result.plan !== undefined ? { plan: result.plan } : {}),
        };
      } else {
        const before = known[account.name];
        if (before) checks[account.name] = before;
      }
    }
    writeSecretFile(checksPath(c), `${JSON.stringify({ checks }, null, 2)}\n`);
  } catch {
    /* a check not remembered is only asked again */
  }
}

/** When the account's login file last changed, or null when it has none here (a Keychain login, say). */
function loginChangedAt(dir: string): number | null {
  try {
    return statSync(credentialPath(dir)).mtimeMs;
  } catch {
    return null;
  }
}

/** The remembered check for `account`, when it can still stand for one made now. */
function usableCheck(
  account: ProbeableAccount,
  check: Checks['checks'][string] | undefined,
  now: number,
  maxAgeMs: number,
): ProbeResult | null {
  if (!check || path.resolve(check.dir) !== path.resolve(account.dir)) return null;
  const age = now - check.checkedAt;
  if (age < 0 || age > maxAgeMs) return null;
  const changed = loginChangedAt(account.dir);
  if (changed !== null && changed > check.checkedAt) return null;
  return {
    name: account.name,
    checkedAt: check.checkedAt,
    loggedIn: check.loggedIn,
    ...(check.email !== undefined ? { email: check.email } : {}),
    ...(check.orgName !== undefined ? { orgName: check.orgName } : {}),
    ...(check.plan !== undefined ? { plan: check.plan } : {}),
  };
}

/**
 * Check every account's login, in parallel, and remember what was found.
 *
 * With `maxAgeMs`, a remembered check at most that old is used instead of
 * asking again, where it can stand for one made now (see above), and only
 * the rest are asked. Null asks about every account, as before.
 */
export async function probeAllRemembered(
  accounts: ProbeableAccount[],
  deps: ProberDeps,
  c: PathCtx,
  maxAgeMs: number | null = null,
): Promise<ProbeResult[]> {
  const now = (deps.now ?? (() => Date.now()))();
  const known = maxAgeMs === null ? {} : readChecks(c).checks;
  const reused = new Map<string, ProbeResult>();
  if (maxAgeMs !== null) {
    for (const account of accounts) {
      const check = usableCheck(account, known[account.name], now, maxAgeMs);
      if (check) reused.set(account.name, check);
    }
  }
  const asked = await Promise.all(
    accounts.filter((a) => !reused.has(a.name)).map((a) => probe(a, deps)),
  );
  if (asked.length > 0) rememberChecks(asked, accounts, c);
  return accounts.map(
    (a) => reused.get(a.name) ?? (asked.find((r) => r.name === a.name) as ProbeResult),
  );
}

/**
 * The number of seconds `--cached-logins` was given, in milliseconds, or why
 * it is not one. Zero is allowed and means a check made this very moment,
 * which in practice asks again.
 */
export function parseCachedLogins(raw: string): { ms: number } | { error: string } {
  const seconds = Number(raw.trim());
  if (raw.trim() === '' || !Number.isFinite(seconds) || seconds < 0) {
    return { error: `--cached-logins takes a number of seconds (0 or more), got "${raw}"` };
  }
  return { ms: Math.round(seconds * 1000) };
}
