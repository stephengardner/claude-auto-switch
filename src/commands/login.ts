import { listAccounts, getAccount, updateAccount } from '../accounts/registry.js';
import { fetchTokenOwner } from '../accounts/identity-check.js';
import { profileAlreadyHolding } from '../accounts/duplicate-guard.js';
import { rollbackCredential } from '../accounts/credential-vault.js';
import { probeAll } from '../health/prober.js';
import { loginAccount, type LoginDeps } from '../login/login.js';
import { cdpBrowserAuthorizer } from '../login/browser.js';
import { spawnAuthLogin } from '../login/login-process.js';
import { getClaude, type CliContext } from '../context.js';
import type { Account } from '../accounts/registry.schema.js';

export interface LoginOptions {
  all?: boolean;
}

/** Log in a stale account via the browser, or every logged-out account with --all. */
export async function loginCommand(
  context: CliContext,
  name?: string,
  options: LoginOptions = {},
): Promise<number> {
  const claude = getClaude(context);

  let targets: Account[];
  if (options.all) {
    const accounts = listAccounts(context.ctx);
    const healths = await probeAll(accounts, { claude });
    const loggedOut = new Set(healths.filter((h) => !h.loggedIn).map((h) => h.name));
    targets = accounts.filter((a) => loggedOut.has(a.name));
    if (targets.length === 0) {
      context.out('all accounts are already logged in');
      return 0;
    }
  } else if (name) {
    const account = getAccount(name, context.ctx);
    if (!account) {
      context.out(`account "${name}" not found`);
      return 1;
    }
    targets = [account];
  } else {
    context.out('specify an account name or --all');
    return 1;
  }

  const deps: LoginDeps = {
    claude,
    browser: cdpBrowserAuthorizer,
    startAuthLogin: spawnAuthLogin,
    debugPort: context.config.browser.debugPort,
  };

  let allOk = true;
  for (const account of targets) {
    context.out(`logging in "${account.name}"...`);
    const result = await loginAccount(
      { name: account.name, dir: account.dir, ...(account.email ? { email: account.email } : {}) },
      deps,
    );
    context.out(`  ${result.ok ? 'ok' : 'FAILED'}: ${result.detail}`);
    if (!result.ok) {
      allOk = false;
      continue;
    }
    // Record who this profile is now, straight from the API. Captured here
    // because a login just proved it, and having it means later checks compare
    // against something known rather than against whatever a file claims.
    const owner = await fetchTokenOwner(account.dir);
    if (!owner) continue;
    context.out(`  signed in as ${owner}`);

    // The browser stays signed in between logins, so a second `ccx login` hands
    // you the SAME account again unless you signed out. That state is refused
    // rather than warned about, because it is not merely useless: renewing a
    // login rotates it, so two profiles sharing one login means renewing either
    // destroys the other, and the account is then gone until it is signed in
    // again. Two accounts here were lost exactly that way.
    const twin = profileAlreadyHolding(owner, listAccounts(context.ctx), account.name);
    if (twin) {
      const restored = rollbackCredential(account.dir);
      context.out(`  REFUSED: ${owner} is already "${twin}".`);
      context.out(
        `  Two profiles on one account cannot both survive: renewing either one ends the other.`,
      );
      context.out(`  Sign out at claude.ai (or use a separate browser profile), then: ccx login ${account.name}`);
      context.out(
        restored
          ? `  "${account.name}" was put back to its previous login.`
          : `  "${account.name}" has no login now; sign it in as a different account.`,
      );
      allOk = false;
      continue;
    }
    updateAccount(account.name, { email: owner }, context.ctx);
  }
  return allOk ? 0 : 1;
}
