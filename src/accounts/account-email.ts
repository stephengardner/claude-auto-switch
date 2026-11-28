import { sessionIdentityEmail } from './credential-vault.js';

/**
 * The address an account belongs to, as `ccx state`, the dashboard, `ccx
 * list`, `ccx status` and `ccx usage` name it. One rule, because those used to
 * answer it separately: `ccx list` and `ccx status` named a signed-out account
 * by nothing even when its record held an address.
 *
 * The address (`email`), most current first:
 *
 * 1. reported: what `claude auth status` in the account's folder reports. Only
 *    a signed-in account has one. It is the identity the folder's config
 *    records, not proof of whose its stored login is (accounts/identity-check
 *    asks the API that).
 * 2. recorded: the account record's `email`, set by `ccx add --email` and by a
 *    sign-in whose owner the API confirmed (login/settle-login). Nothing that
 *    only reads writes it. It is the only address `ccx login` checks a sign-in
 *    against.
 *
 * Apart from it, never in its place, the CLAIMED address (`claimedEmail`):
 * what the profile's own `.claude.json` says it is signed in as
 * (oauthAccount.emailAddress), read while nothing reports or records one.
 * Nothing has checked it, and `ccx login` does not check a sign-in against
 * it, so it is never proof of which account will approve one. It is given
 * only when exactly one such account claims it and no account reports or
 * records it: a refused sign-in puts the credential back but leaves the
 * profile claiming the address it was refused for, so a claim shared with
 * another account names an account that may not be this one.
 *
 * The identity check keeps its own expectation (record, else the claim),
 * because it tests that expectation against the API's answer rather than
 * publishing it. The checks that hold a profile to its record (such as
 * login/settle-login, accounts/duplicate-guard and session/session-identity)
 * read the record alone.
 */

/** Reads what a profile folder claims to be signed in as (credential-vault). */
export type ClaimReader = (dir: string) => string | null;

/**
 * The address of an account: what its login check reports, else what is
 * recorded for it. Undefined when neither is known; a blank address counts as
 * none.
 */
export function accountEmail(
  account: { email?: string | undefined },
  live?: string | null,
): string | undefined {
  return present(live) ?? present(account.email);
}

/** What is published about an account's address. At most one of the two is set. */
export interface AccountAddress {
  /** Reported, else recorded: see accountEmail. */
  email?: string;
  /** Unchecked: what its profile claims, when nothing reports or records one (see the file header). */
  claimedEmail?: string;
}

/**
 * Every account's address, by name: the reported or recorded one when there
 * is one, else the profile's claim, when exactly one account with nothing
 * reported or recorded makes it and no account reports or records it
 * (compared without case). A profile is read only for an account with
 * nothing reported or recorded, since this runs on every frame of the
 * dashboard and a profile's `.claude.json` can be large.
 */
export function accountAddresses(
  accounts: ReadonlyArray<{ name: string; dir: string; email?: string | undefined }>,
  live: ReadonlyMap<string, string>,
  readClaim: ClaimReader = sessionIdentityEmail,
): Map<string, AccountAddress> {
  const addresses = new Map<string, AccountAddress>();
  // Every address an account reports or is recorded as.
  const held = new Set<string>();
  // What each account with nothing reported or recorded claims, and how many claim it.
  const claims = new Map<string, string>();
  const claimants = new Map<string, number>();
  for (const a of accounts) {
    for (const address of [present(a.email), present(live.get(a.name))]) {
      if (address !== undefined) held.add(key(address));
    }
    const email = accountEmail(a, live.get(a.name));
    if (email !== undefined) {
      addresses.set(a.name, { email });
      continue;
    }
    const claimed = present(readClaim(a.dir));
    if (claimed === undefined) continue;
    claims.set(a.name, claimed);
    claimants.set(key(claimed), (claimants.get(key(claimed)) ?? 0) + 1);
  }
  for (const a of accounts) {
    if (addresses.has(a.name)) continue;
    const claimed = claims.get(a.name);
    const alone =
      claimed !== undefined && !held.has(key(claimed)) && claimants.get(key(claimed)) === 1;
    addresses.set(a.name, alone ? { claimedEmail: claimed } : {});
  }
  return addresses;
}

function present(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function key(email: string): string {
  return email.trim().toLowerCase();
}
