import { runCapture } from '../util/exec.js';
import { parseAuthStatus, type Health } from './auth-status.js';
import { invokerArgs, type ClaudeInvoker } from '../invoker.js';

/** Minimal account shape the prober needs (registry Account satisfies this). */
export interface ProbeableAccount {
  name: string;
  dir: string;
}

export interface ProbeResult extends Health {
  name: string;
  checkedAt: number;
  /** Set when auth status could not be parsed; the account is treated logged out. */
  error?: string;
}

export interface ProberDeps {
  claude: ClaudeInvoker;
  /** Injectable clock so `checkedAt` is deterministic in tests. */
  now?: () => number;
}

/** Probe one account's health via `claude auth status`. Never spends model tokens. */
export async function probe(account: ProbeableAccount, deps: ProberDeps): Promise<ProbeResult> {
  const now = deps.now ?? (() => Date.now());
  const argv = invokerArgs(deps.claude, ['auth', 'status']);
  const result = await runCapture(deps.claude.bin, argv, {
    env: { CLAUDE_CONFIG_DIR: account.dir },
  });
  try {
    const health = parseAuthStatus(result.stdout);
    return { name: account.name, checkedAt: now(), ...health };
  } catch (err) {
    return {
      name: account.name,
      checkedAt: now(),
      loggedIn: false,
      error: (err as Error).message,
    };
  }
}

/** Probe many accounts in parallel. */
export async function probeAll(
  accounts: ProbeableAccount[],
  deps: ProberDeps,
): Promise<ProbeResult[]> {
  return Promise.all(accounts.map((account) => probe(account, deps)));
}
