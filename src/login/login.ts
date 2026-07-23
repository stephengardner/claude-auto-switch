import { invokerArgs, type ClaudeInvoker } from '../invoker.js';

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

  const url = await proc.urlHint();
  const outcome = await deps.browser.authorize({ url, email: account.email, debugPort: deps.debugPort });

  if (outcome === 'failed') {
    return {
      account: account.name,
      ok: false,
      detail: 'browser authorization failed; finish the login manually in the open browser',
    };
  }

  const exitCode = await proc.done();
  return {
    account: account.name,
    ok: exitCode === 0,
    detail: exitCode === 0 ? `logged in (${outcome})` : `login process exited ${exitCode}`,
  };
}
