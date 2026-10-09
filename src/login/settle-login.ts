import { listAccounts, updateAccount } from '../accounts/registry.js';
import { fetchTokenOwner } from '../accounts/identity-check.js';
import { profileAlreadyHolding, renewalWouldBreakOthers } from '../accounts/duplicate-guard.js';
import { rollbackCredential, clearCredential } from '../accounts/credential-vault.js';
import type { CliContext } from '../context.js';

/**
 * The single place a fresh sign-in is accepted or refused.
 *
 * Every command that signs a profile in goes through here, because there is more
 * than one way to sign in (`ccx add` does it while registering, `ccx login` does
 * it on its own) and a check that only one of them performs is not a check. The
 * duplicate this refuses was originally created by the `add` path.
 */

export interface SettleResult {
  ok: boolean;
  /** Who the new login belongs to, when that could be established. */
  owner?: string;
  /** The profile that already held this account, when it was refused. */
  twin?: string;
}

export interface SettleOptions {
  /** Injectable for tests; defaults to the real API lookup. */
  lookupOwner?: (dir: string) => Promise<string | null>;
}

/**
 * Check a just-completed sign-in and refuse it if another profile already holds
 * that account.
 *
 * Refused rather than warned about, because the state is destructive and not
 * merely wasteful: signing in replaces a login, so two profiles sharing one
 * means renewing either ends the other, and that account is gone until somebody
 * signs it in by hand. Two accounts here were lost exactly that way.
 */
export async function settleNewLogin(
  context: CliContext,
  account: { name: string; dir: string },
  options: SettleOptions = {},
): Promise<SettleResult> {
  const accounts = listAccounts(context.ctx);

  // Compared locally FIRST, so the dangerous case is caught even with no network.
  // Identical stored logins are the exact shape that kills an account on renewal.
  const shared = renewalWouldBreakOthers(account, accounts);
  if (shared.length > 0) {
    return refuse(context, account, shared[0] as string);
  }

  const lookup = options.lookupOwner ?? context.lookupOwner ?? fetchTokenOwner;
  const owner = await lookup(account.dir);
  if (!owner) {
    // No answer means offline or a rejected token, not proof of a duplicate. The
    // login stays (rolling back a good sign-in over a network blip is worse), but
    // it is said plainly rather than passed off as verified.
    context.out('  could not confirm which account this is (offline?); run: ccx doctor');
    return { ok: true };
  }
  context.out(`  signed in as ${owner}`);

  // Checked before the duplicate rule because it is the cause when both apply:
  // a browser signed in to another account approves every sign-in as that one.
  const registered = accounts.find((a) => a.name === account.name)?.email;
  if (registered && registered.trim().toLowerCase() !== owner.trim().toLowerCase()) {
    return { ...refuseOtherAccount(context, account, registered, owner), owner };
  }

  const twin = profileAlreadyHolding(owner, accounts, account.name);
  if (twin) return { ...refuse(context, account, twin), owner };

  // Recorded straight from the API, so later checks compare against something
  // known rather than against whatever a local file claims about itself.
  updateAccount(account.name, { email: owner }, context.ctx);
  return { ok: true, owner };
}

/**
 * Refuse a sign-in that came back as a different account than the profile is
 * registered for, putting the profile back as `refuse` does.
 */
function refuseOtherAccount(
  context: CliContext,
  account: { name: string; dir: string },
  registered: string,
  owner: string,
): SettleResult {
  const restored = restoreOrClear(account.dir);
  context.out(`  REFUSED: "${account.name}" is registered as ${registered}, but this sign-in is ${owner}.`);
  context.out(`  The browser that approved it is signed in to ${owner}.`);
  context.out(
    `  Switch it to ${registered} (or use a separate browser profile), then: ccx login ${account.name}`,
  );
  context.out(
    `  If "${account.name}" should hold ${owner} instead: ccx remove ${account.name}, then ccx add ${account.name} --email ${owner}`,
  );
  context.out(
    restored
      ? `  "${account.name}" was put back to its previous login.`
      : `  "${account.name}" has no login now.`,
  );
  return { ok: false };
}

/** Put the previous login back, or clear the refused one when there is none. */
function restoreOrClear(dir: string): boolean {
  const restored = rollbackCredential(dir);
  if (!restored) clearCredential(dir);
  return restored;
}

/**
 * Put the profile back the way it was and explain what to do instead.
 *
 * When there is nothing to go back to, the refused login is REMOVED rather than
 * left in place: leaving it would keep the duplicate active, which is the exact
 * state being refused, and would contradict what is printed.
 */
function refuse(
  context: CliContext,
  account: { name: string; dir: string },
  twin: string,
): SettleResult {
  const restored = restoreOrClear(account.dir);
  context.out(`  REFUSED: this is the same account as "${twin}".`);
  context.out(
    '  Two profiles on one account cannot both survive: renewing either one ends the other.',
  );
  context.out(
    `  Sign out at claude.ai (or use a separate browser profile), then: ccx login ${account.name}`,
  );
  context.out(
    restored
      ? `  "${account.name}" was put back to its previous login.`
      : `  "${account.name}" has no login now; sign it in as a different account.`,
  );
  return { ok: false, twin };
}
