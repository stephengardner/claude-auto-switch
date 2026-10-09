import { invokerArgs, type ClaudeInvoker } from '../invoker.js';
import { credentialFingerprint } from '../accounts/credential-vault.js';
import { runInherit } from '../util/exec.js';

export type AuthorizeOutcome = 'authorized' | 'left-open' | 'failed';

/** Abstracts the browser step so login orchestration is testable without Chrome. */
export interface BrowserAuthorizer {
  authorize(input: { url?: string; email?: string; debugPort: number }): Promise<AuthorizeOutcome>;
}

/** A running `claude auth login` process, abstracted for testability. */
export interface AuthLoginProcess {
  /** The auth URL printed early, or undefined if the CLI auto-opens the browser. */
  urlHint(): Promise<string | undefined>;
  /** The process exit code once the login completes. */
  done(): Promise<number>;
  /** Stop the process. Called when the wait is given up on. */
  cancel?: () => void;
  /** Answer the "Paste code here" prompt; present only when started with `acceptsCode`. */
  submitCode?: (code: string) => void;
  /** The last thing the process printed, which says why a code was refused. */
  lastLine?: () => string | undefined;
}

export interface StartAuthLoginOptions {
  /** Keep the process's input open so a pasted code can be handed to it. */
  acceptsCode?: boolean;
  /** How long to wait for the sign-in link before reporting there is none. */
  urlWaitMs?: number;
}

export type StartAuthLogin = (
  invoker: ClaudeInvoker,
  args: string[],
  env: NodeJS.ProcessEnv,
  options?: StartAuthLoginOptions,
) => AuthLoginProcess;

export interface LoginDeps {
  claude: ClaudeInvoker;
  browser: BrowserAuthorizer;
  startAuthLogin: StartAuthLogin;
  debugPort: number;
  /** Told what is happening while the login runs, so the person is not left guessing. */
  notify?: (message: string) => void;
  /**
   * Fingerprint of the login stored for an account, for telling whether the
   * sign-in actually produced a new one. Injected for tests.
   */
  fingerprint?: (dir: string) => string | null;
  /**
   * How long to wait for the sign-in before giving up. Generous, because a real
   * one goes through a browser at human speed, but not unbounded: a sign-in
   * nobody finishes used to hold the caller forever, and the dashboard hands its
   * screen away while it waits.
   */
  timeoutMs?: number;
}

export interface LoginAccountInput {
  name: string;
  dir: string;
  email?: string;
}

export interface LoginResult {
  account: string;
  ok: boolean;
  detail: string;
}

/**
 * Orchestrate a single account login: start `claude auth login`, drive the
 * browser to click Authorize, then wait for the login process to finish. The
 * browser and process are injected so this decision logic is fully testable
 * without a real Chrome or a real login.
 */
export async function loginAccount(
  account: LoginAccountInput,
  deps: LoginDeps,
): Promise<LoginResult> {
  const args = authLoginArgs(deps.claude, account.email);
  // What the account holds BEFORE, so afterwards we can tell whether a new login
  // was actually written rather than guessing from how the browser step went.
  const fingerprint = deps.fingerprint ?? credentialFingerprint;
  const before = fingerprint(account.dir);
  const proc = deps.startAuthLogin(deps.claude, args, { CLAUDE_CONFIG_DIR: account.dir });

  const url = await proc.urlHint();
  const outcome = await deps.browser.authorize({ url, email: account.email, debugPort: deps.debugPort });

  if (outcome === 'failed') {
    // Driving the browser failed, but the sign-in page is open and can be
    // finished by hand, so this is NOT a verdict. Returning here reported
    // failure for sign-ins that then succeeded, which is exactly what happened:
    // the account was signed in and ccx said it was not.
    deps.notify?.('could not drive the browser; finish the sign-in there and this will pick it up');
  }

  const exitCode = await waitForLogin(proc, deps.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
  if (exitCode === TIMED_OUT) {
    proc.cancel?.();
    const stored = fingerprint(account.dir);
    // Even a give-up can find the sign-in was finished just in time.
    if (stored !== null && stored !== before) {
      return { account: account.name, ok: true, detail: 'logged in (completed manually)' };
    }
    return {
      account: account.name,
      ok: false,
      detail: 'gave up waiting for the sign-in to be completed',
    };
  }
  // Not "logged in (failed)": the browser step failing while the person
  // finishes by hand is the ordinary path here, and a success line containing
  // the word failed reads as a contradiction.
  return judgeStoredLogin(
    account.name,
    before,
    fingerprint(account.dir),
    exitCode,
    outcome === 'failed' ? 'completed manually' : outcome,
  );
}

/** The arguments for `claude auth login`, the same for every way of signing in. */
export function authLoginArgs(claude: ClaudeInvoker, email?: string): string[] {
  return invokerArgs(claude, ['auth', 'login', '--claudeai', ...(email ? ['--email', email] : [])]);
}

/**
 * The truth is what ended up on disk. A new login means it worked, whatever the
 * browser step or the exit code said; no new login means it did not, even if the
 * process exited cleanly.
 */
function judgeStoredLogin(
  name: string,
  before: string | null,
  after: string | null,
  exitCode: number,
  how: string,
): LoginResult {
  if (after !== null && after !== before) {
    return { account: name, ok: true, detail: `logged in (${how})` };
  }
  if (exitCode === 0 && after !== null) {
    // Signed in already, and nothing changed: still a usable account.
    return { account: name, ok: true, detail: 'already signed in; nothing changed' };
  }
  return {
    account: name,
    ok: false,
    detail:
      after === null
        ? 'no login was stored; the sign-in was not completed'
        : `login process exited ${exitCode}`,
  };
}

export interface TerminalLoginDeps {
  claude: ClaudeInvoker;
  /** Runs the sign-in attached to this terminal. Injected for tests. */
  run?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
  fingerprint?: (dir: string) => string | null;
}

/**
 * Sign in with the terminal doing the talking: Claude prints the link and reads
 * the pasted code itself. For a machine with no browser to drive, such as one
 * reached over SSH, where the browser step can only wait for nothing.
 */
export async function loginInTerminal(
  account: LoginAccountInput,
  deps: TerminalLoginDeps,
): Promise<LoginResult> {
  const fingerprint = deps.fingerprint ?? credentialFingerprint;
  const run = deps.run ?? ((bin, args, env) => runInherit(bin, args, { env }));
  const before = fingerprint(account.dir);
  const exitCode = await run(deps.claude.bin, authLoginArgs(deps.claude, account.email), {
    CLAUDE_CONFIG_DIR: account.dir,
  });
  return judgeStoredLogin(account.name, before, fingerprint(account.dir), exitCode, 'in the terminal');
}

/**
 * Marks the one line of a relayed sign-in that is meant for the machine driving
 * it rather than for a person: the link to approve. Everything else is relayed
 * to the person as written.
 */
export const RELAY_URL_PREFIX = 'ccx-relay-url ';

/** Claude reads its pasted code as `<code>#<state>`, split on the `#`. */
const RELAY_CODE_RE = /^[^\s#]+#[^\s#]+$/;
/** Starting claude on a slow server can take seconds before the link appears. */
const RELAY_URL_WAIT_MS = 30_000;
/** Turning a code into a login is one request; a minute means it is not happening. */
const CODE_EXCHANGE_TIMEOUT_MS = 60_000;

export interface RelayLoginDeps {
  claude: ClaudeInvoker;
  startAuthLogin: StartAuthLogin;
  /** One line to the machine driving this sign-in. */
  send: (line: string) => void;
  /** The code that machine sends back, or null when none arrives in time. */
  receiveCode: (timeoutMs: number) => Promise<string | null>;
  fingerprint?: (dir: string) => string | null;
  /** How long to wait for the code: the time a person takes to approve. */
  timeoutMs?: number;
  exchangeTimeoutMs?: number;
}

/**
 * The half of a sign-in that runs on the machine being signed in, while another
 * machine approves it in its browser (`ccx login --host`). Sends the link out,
 * takes the code back, and gives it to Claude's paste prompt. Whether to keep
 * the login is still decided here, by the caller, exactly as for a local one.
 */
export async function relayLogin(
  account: LoginAccountInput,
  deps: RelayLoginDeps,
): Promise<LoginResult> {
  const fingerprint = deps.fingerprint ?? credentialFingerprint;
  const fail = (detail: string): LoginResult => ({ account: account.name, ok: false, detail });
  const before = fingerprint(account.dir);
  const proc = deps.startAuthLogin(
    deps.claude,
    authLoginArgs(deps.claude, account.email),
    { CLAUDE_CONFIG_DIR: account.dir },
    { acceptsCode: true, urlWaitMs: RELAY_URL_WAIT_MS },
  );

  const url = await proc.urlHint();
  if (!url || !proc.submitCode) {
    proc.cancel?.();
    return fail('claude printed no sign-in link to relay');
  }
  deps.send(`${RELAY_URL_PREFIX}${url}`);

  const code = await deps.receiveCode(deps.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
  if (!code) {
    proc.cancel?.();
    return fail('no code arrived from the machine approving the sign-in');
  }
  if (!RELAY_CODE_RE.test(code)) {
    proc.cancel?.();
    return fail('the code was not in the form claude reads (code#state)');
  }
  proc.submitCode(code);
  const why = (): string => {
    const said = proc.lastLine?.();
    return said ? ` (claude said: ${said})` : '';
  };

  const exitCode = await waitForLogin(proc, deps.exchangeTimeoutMs ?? CODE_EXCHANGE_TIMEOUT_MS);
  if (exitCode === TIMED_OUT) {
    proc.cancel?.();
    const after = fingerprint(account.dir);
    if (after !== null && after !== before) {
      return { account: account.name, ok: true, detail: 'logged in (relayed)' };
    }
    return fail(`the code was not accepted${why()}`);
  }
  const judged = judgeStoredLogin(account.name, before, fingerprint(account.dir), exitCode, 'relayed');
  return judged.ok ? judged : { ...judged, detail: `${judged.detail}${why()}` };
}

/** Sentinel for "the wait was given up on", distinct from any real exit code. */
const TIMED_OUT = -1;

/** Generous: a real sign-in goes through a browser at human speed. */
export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;

/**
 * Wait for the login process, but not forever. Returns TIMED_OUT if the wait
 * runs out. The timer is cleared either way, so a finished login never leaves
 * the process hanging around waiting for it.
 */
async function waitForLogin(proc: AuthLoginProcess, timeoutMs: number): Promise<number> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      proc.done(),
      new Promise<number>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
