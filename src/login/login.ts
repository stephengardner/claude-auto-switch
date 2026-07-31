import { invokerArgs, type ClaudeInvoker } from '../invoker.js';
import { credentialFingerprint } from '../accounts/credential-vault.js';

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
}

export type StartAuthLogin = (
  invoker: ClaudeInvoker,
  args: string[],
  env: NodeJS.ProcessEnv,
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
  const args = invokerArgs(deps.claude, [
    'auth',
    'login',
    '--claudeai',
    ...(account.email ? ['--email', account.email] : []),
  ]);
  const proc = deps.startAuthLogin(deps.claude, args, { CLAUDE_CONFIG_DIR: account.dir });

  // What the account holds BEFORE, so afterwards we can tell whether a new login
  // was actually written rather than guessing from how the browser step went.
  const fingerprint = deps.fingerprint ?? credentialFingerprint;
  const before = fingerprint(account.dir);

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
  const after = fingerprint(account.dir);
  // The truth is what ended up on disk. A new login means it worked, whatever
  // the browser step or the exit code said; no new login means it did not, even
  // if the process exited cleanly.
  const gotNewLogin = after !== null && after !== before;
  if (gotNewLogin) {
    // Not "logged in (failed)": the browser step failing while the person
    // finishes by hand is the ordinary path here, and a success line containing
    // the word failed reads as a contradiction.
    return {
      account: account.name,
      ok: true,
      detail: outcome === 'failed' ? 'logged in (completed manually)' : `logged in (${outcome})`,
    };
  }
  if (exitCode === 0 && after !== null) {
    // Signed in already, and nothing changed: still a usable account.
    return { account: account.name, ok: true, detail: 'already signed in; nothing changed' };
  }
  return {
    account: account.name,
    ok: false,
    detail:
      after === null
        ? 'no login was stored; the sign-in was not completed'
        : `login process exited ${exitCode}`,
  };
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
