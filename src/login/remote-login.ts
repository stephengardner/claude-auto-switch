import { listAccounts } from '../accounts/registry.js';
import { RELAY_URL_PREFIX } from './login.js';
import {
  browserPortReachable,
  cdpSignInApprover,
  isAnthropicSignInUrl,
  isClaudeCodeSignIn,
  type SignInApprover,
} from './browser.js';
import {
  COMMAND_NOT_FOUND,
  SSH_FAILED,
  SSH_UNAVAILABLE,
  assertSshHost,
  sshRunner,
  type RemoteRunner,
} from '../remote/ssh.js';
import { readOneLine } from '../util/read-line.js';
import type { CliContext } from '../context.js';

/**
 * `ccx login --host`: sign in another machine's accounts from this one.
 *
 * Each machine keeps its own login of each account, because a refresh token
 * works once and two machines sharing one log each other out. What this saves
 * is doing those sign-ins over there by hand: ccx on the other machine starts
 * each one and sends its link here, this machine's browser approves it, and the
 * code goes back. The other machine's ccx still decides whether to keep the
 * login, with the same identity and duplicate checks as a local sign-in.
 */

/** The first ccx that answers `login --relay`. */
const RELAY_SINCE = [2, 3, 0] as const;
/** Time for a browser that ccx drives to get from the link to the code. */
const APPROVE_TIMEOUT_MS = 3 * 60_000;
/**
 * Everything this side may take to produce a code once the link arrives,
 * browser and pasting together. Kept under the relay's own wait
 * (RELAY_CODE_WAIT_MS) so the other end is still listening when it is sent.
 */
export const HOST_CODE_BUDGET_MS = 9 * 60_000;

export interface HostLoginOptions {
  all?: boolean;
  /** How ccx is run on the other machine, when a login shell does not find it. */
  remoteCcx?: string;
}

export interface HostLoginDeps {
  runner?: RemoteRunner;
  approver?: SignInApprover;
  browserReachable?: (port: number) => Promise<boolean>;
  /** Asks the person for the code when no browser here can be driven. */
  askCode?: (url: string, who: string, timeoutMs: number) => Promise<string | null>;
}

interface RemoteAccount {
  name: string;
  email?: string;
  loggedIn: boolean;
  enabled: boolean;
}

export async function loginOnHost(
  context: CliContext,
  host: string,
  name: string | undefined,
  options: HostLoginOptions = {},
  deps: HostLoginDeps = {},
): Promise<number> {
  try {
    assertSshHost(host);
  } catch (err) {
    context.out((err as Error).message);
    return 1;
  }
  if (!name && !options.all) {
    context.out('specify an account name or --all');
    return 1;
  }
  const runner =
    deps.runner ?? sshRunner(host, options.remoteCcx ? { ccx: options.remoteCcx } : {});

  const remote = await readRemoteAccounts(context, host, runner);
  if (!remote) return 1;
  const local = new Map(listAccounts(context.ctx).map((a) => [a.name, a] as const));

  let targets: string[];
  if (name) {
    if (!remote.has(name) && !local.has(name)) {
      context.out(`no account named "${name}" here or on ${host}`);
      return 1;
    }
    targets = [name];
  } else {
    const names = new Set([
      ...[...local.values()].filter((a) => a.enabled !== false).map((a) => a.name),
      ...[...remote.values()].filter((a) => a.enabled).map((a) => a.name),
    ]);
    targets = [...names].filter((n) => !remote.get(n)?.loggedIn);
    if (targets.length === 0) {
      context.out(`every account on ${host} is already signed in`);
      return 0;
    }
  }

  let allOk = true;
  for (const target of targets) {
    const email = remote.get(target)?.email ?? local.get(target)?.email;
    if (!remote.has(target)) {
      // Only the name and address go across; never a login.
      const added = await runner.run(['add', target, ...(email ? ['--email', email] : []), '--no-login']);
      if (added.exitCode !== 0) {
        context.out(`could not register "${target}" on ${host}: ${lastLine(added.stdout || added.stderr)}`);
        allOk = false;
        continue;
      }
      context.out(`registered "${target}" on ${host}`);
    }
    if (!(await relayOne(context, host, runner, target, email, deps))) allOk = false;
  }
  return allOk ? 0 : 1;
}

async function readRemoteAccounts(
  context: CliContext,
  host: string,
  runner: RemoteRunner,
): Promise<Map<string, RemoteAccount> | null> {
  const state = await runner.run(['state']);
  if (state.exitCode === SSH_UNAVAILABLE) {
    context.out(`could not run ssh on this machine: ${lastLine(state.stderr)}`);
    return null;
  }
  if (state.exitCode === SSH_FAILED) {
    context.out(`could not reach ${host} over ssh: ${lastLine(state.stderr)}`);
    return null;
  }
  if (
    state.exitCode === COMMAND_NOT_FOUND ||
    (state.exitCode !== 0 && /command not found/i.test(state.stderr))
  ) {
    context.out(`ccx was not found on ${host}.`);
    context.out('  Install it there (npm install -g claude-auto-switch) so a login shell finds it and node,');
    context.out("  or name both: --remote-ccx '/path/to/node /path/to/ccx'");
    return null;
  }
  let parsed: { ccxVersion?: string; accounts?: RemoteAccount[] };
  try {
    parsed = parseState(state.stdout) as typeof parsed;
  } catch {
    context.out(`ccx on ${host} did not report its state: ${lastLine(state.stderr || state.stdout)}`);
    return null;
  }
  if (!versionAtLeast(parsed.ccxVersion, RELAY_SINCE)) {
    context.out(
      `ccx on ${host} is ${parsed.ccxVersion ?? 'an unknown version'}; signing in from here needs ${RELAY_SINCE.join('.')} or newer there.`,
    );
    context.out(`  Update it on ${host}: npm install -g claude-auto-switch`);
    return null;
  }
  return new Map((parsed.accounts ?? []).map((a) => [a.name, a] as const));
}

/** Relay one sign-in: the remote ccx sends a link, this machine gets the code, the code goes back. */
async function relayOne(
  context: CliContext,
  host: string,
  runner: RemoteRunner,
  name: string,
  email: string | undefined,
  deps: HostLoginDeps,
): Promise<boolean> {
  context.out(`signing in "${name}" on ${host}${email ? ` as ${email}` : ''}...`);
  const session = runner.start(['login', name, '--relay']);
  for await (const line of session.lines) {
    if (!line.startsWith(RELAY_URL_PREFIX)) {
      if (line.trim()) context.out(`  ${host}: ${line.trim()}`);
      continue;
    }
    const url = line.slice(RELAY_URL_PREFIX.length).trim();
    const code = await codeFor(context, host, url, email ?? `the account for "${name}"`, deps);
    if (code) session.send(code);
    // Closing its input tells the remote no code is coming, so it stops at once
    // rather than waiting out its timeout.
    session.end();
  }
  return (await session.done()) === 0;
}

async function codeFor(
  context: CliContext,
  host: string,
  url: string,
  who: string,
  deps: HostLoginDeps,
): Promise<string | null> {
  if (!isAnthropicSignInUrl(url)) {
    context.out(`  REFUSED: ${host} sent a sign-in link that is not Anthropic's, so it was not opened.`);
    return null;
  }
  const deadline = Date.now() + HOST_CODE_BUDGET_MS;
  const port = context.config.browser.debugPort;
  if (!isClaudeCodeSignIn(url)) {
    context.out(`  ${host} sent a link that is not a Claude Code sign-in ccx recognizes,`);
    context.out('  so it is not approved automatically. Look at the page before you approve anything.');
  } else if (await (deps.browserReachable ?? browserPortReachable)(port)) {
    const approved = await (deps.approver ?? cdpSignInApprover).approve({
      url,
      debugPort: port,
      timeoutMs: APPROVE_TIMEOUT_MS,
    });
    if (approved.code) {
      context.out("  approved in this machine's browser");
      return approved.code;
    }
    context.out('  could not finish it in the browser automatically');
  }
  return (deps.askCode ?? askForCode(context))(url, who, Math.max(0, deadline - Date.now()));
}

function askForCode(
  context: CliContext,
): (url: string, who: string, timeoutMs: number) => Promise<string | null> {
  return async (url, who, timeoutMs) => {
    const minutes = Math.max(1, Math.floor(timeoutMs / 60_000));
    context.out(`  open this link in a browser signed in to ${who}, approve, and paste the code it shows`);
    context.out(`  within ${minutes} minute${minutes === 1 ? '' : 's'}:`);
    context.out(`    ${url}`);
    process.stdout.write('  code: ');
    return readOneLine(timeoutMs);
  };
}

/**
 * The login shell runs the remote profile first, and a profile may print a
 * greeting, so the state is the JSON from the first line that starts one and
 * parses to the end of the output.
 */
function parseState(stdout: string): unknown {
  const starts = [0, ...[...stdout.matchAll(/^\{/gm)].map((m) => m.index ?? 0)];
  for (const start of starts) {
    try {
      return JSON.parse(stdout.slice(start));
    } catch {
      /* not this one */
    }
  }
  throw new Error('no state in the output');
}

function lastLine(text: string): string {
  const lines = text.trim().split(/\r?\n/);
  return lines[lines.length - 1] || 'no output';
}

function versionAtLeast(version: string | undefined, wanted: readonly number[]): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!parts) return false;
  for (let i = 0; i < 3; i++) {
    const have = Number(parts[i + 1]);
    if (have !== wanted[i]) return have > (wanted[i] as number);
  }
  return true;
}
