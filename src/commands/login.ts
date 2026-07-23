import { listAccounts, getAccount } from '../accounts/registry.js';
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
    if (!result.ok) allOk = false;
  }
  return allOk ? 0 : 1;
}
