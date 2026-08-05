import { listAccounts, getAccount } from '../accounts/registry.js';
import { settleNewLogin } from '../login/settle-login.js';
import { probeAll } from '../health/prober.js';
import { loginAccount, type LoginDeps } from '../login/login.js';
import { cdpBrowserAuthorizer } from '../login/browser.js';
import { spawnAuthLogin } from '../login/login-process.js';
import { getClaude, type CliContext } from '../context.js';
import type { Account } from '../accounts/registry.schema.js';
import { signedInAndNotRejected } from '../health/signed-in.js';

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
    // The same question as everywhere else, asked the other way round. The
    // probe reports a refused login as signed in, because the file still looks
    // like one, so going by the probe alone made `--all` skip exactly the
    // accounts that need signing in and announce that they were all fine.
    const usable = signedInAndNotRejected(healths, accounts, context.ctx);
    targets = accounts.filter((a) => !usable.has(a.name));
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
    notify: (m) => context.out(`  ${m}`),
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
    // Accepted or refused in one shared place, so `ccx add` and `ccx login`
    // cannot disagree about what a valid sign-in is.
    const settled = await settleNewLogin(context, { name: account.name, dir: account.dir });
    if (!settled.ok) allOk = false;
  }
  return allOk ? 0 : 1;
}
