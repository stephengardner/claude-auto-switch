import { listAccounts, getAccount } from '../accounts/registry.js';
import { keepRollbackPoint, settleNewLogin } from '../login/settle-login.js';
import { probeAll } from '../health/prober.js';
import {
  loginAccount,
  loginInTerminal,
  relayLogin,
  type LoginAccountInput,
  type LoginDeps,
  type LoginResult,
} from '../login/login.js';
import { browserPortReachable, cdpBrowserAuthorizer } from '../login/browser.js';
import { spawnAuthLogin } from '../login/login-process.js';
import { loginOnHost } from '../login/remote-login.js';
import { isHeadlessSession } from '../util/headless.js';
import { readOneLine } from '../util/read-line.js';
import { getClaude, type CliContext } from '../context.js';
import type { Account } from '../accounts/registry.schema.js';
import { signedInAndNotRejected } from '../health/signed-in.js';

export interface LoginOptions {
  all?: boolean;
  /** Sign in the accounts of another machine, reached over SSH, from this one. */
  host?: string;
  /** How to run ccx on that machine. */
  remoteCcx?: string;
  /** The other machine's half of `--host`: relay one sign-in through standard input and output. */
  relay?: boolean;
}

/**
 * Injected in tests so which accounts get signed in can be checked without
 * spawning a probe per account. Driving the real prober from a test made an
 * earlier one depend on a subprocess finishing, which passed on one platform
 * and failed on another for a reason unrelated to the rule being tested.
 */
export interface LoginCommandDeps {
  probe?: typeof probeAll;
  login?: typeof loginAccount;
  /** Whether nobody is at a browser here; read from the session when absent. */
  headless?: boolean;
  browserReachable?: (port: number) => Promise<boolean>;
  terminalLogin?: (account: LoginAccountInput) => Promise<LoginResult>;
  relay?: (account: LoginAccountInput) => Promise<LoginResult>;
  remote?: typeof loginOnHost;
}

/** Log in a stale account via the browser, or every logged-out account with --all. */
export async function loginCommand(
  context: CliContext,
  name?: string,
  options: LoginOptions = {},
  commandDeps: LoginCommandDeps = {},
): Promise<number> {
  if (options.host) {
    return (commandDeps.remote ?? loginOnHost)(context, options.host, name, {
      ...(options.all ? { all: true } : {}),
      ...(options.remoteCcx ? { remoteCcx: options.remoteCcx } : {}),
    });
  }
  const claude = getClaude(context);
  if (options.relay) return relayCommand(context, name, options, commandDeps);

  const probeAccounts = commandDeps.probe ?? probeAll;
  const signIn = commandDeps.login ?? loginAccount;

  let targets: Account[];
  if (options.all) {
    const accounts = listAccounts(context.ctx);
    const healths = await probeAccounts(accounts, { claude });
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

  // With nobody at a browser here, the browser step can only wait for nothing,
  // and the paste prompt Claude offers instead is the way in.
  const headless =
    commandDeps.headless ?? isHeadlessSession(context.ctx.env ?? process.env, context.ctx.platform ?? process.platform);
  const inTerminal =
    headless && !(await (commandDeps.browserReachable ?? browserPortReachable)(deps.debugPort));
  if (inTerminal) {
    context.out('no browser on this machine: Claude prints a link to open on any device, then asks for the code it shows');
    context.out('  (or sign in from a machine with a browser: ccx login --host <this machine>)');
  }
  const terminal =
    commandDeps.terminalLogin ?? ((account: LoginAccountInput) => loginInTerminal(account, { claude }));

  let allOk = true;
  for (const account of targets) {
    context.out(`logging in "${account.name}"...`);
    const input = { name: account.name, dir: account.dir, ...(account.email ? { email: account.email } : {}) };
    keepRollbackPoint(context, account);
    const result = inTerminal ? await terminal(input) : await signIn(input, deps);
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

/** One sign-in driven by another machine; see login/remote-login.ts for that side. */
async function relayCommand(
  context: CliContext,
  name: string | undefined,
  options: LoginOptions,
  commandDeps: LoginCommandDeps,
): Promise<number> {
  if (!name || options.all) {
    context.out('--relay signs in one named account');
    return 1;
  }
  const account = getAccount(name, context.ctx);
  if (!account) {
    context.out(`account "${name}" not found`);
    return 1;
  }
  const input = { name: account.name, dir: account.dir, ...(account.email ? { email: account.email } : {}) };
  const relay =
    commandDeps.relay ??
    ((a: LoginAccountInput) =>
      relayLogin(a, {
        claude: getClaude(context),
        startAuthLogin: spawnAuthLogin,
        send: (line) => context.out(line),
        receiveCode: (timeoutMs) => readOneLine(timeoutMs),
      }));
  keepRollbackPoint(context, account);
  const result = await relay(input);
  context.out(`  ${result.ok ? 'ok' : 'FAILED'}: ${result.detail}`);
  if (!result.ok) return 1;
  const settled = await settleNewLogin(context, { name: account.name, dir: account.dir });
  return settled.ok ? 0 : 1;
}
