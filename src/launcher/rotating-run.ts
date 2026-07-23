import type { ClaudeInvoker } from '../invoker.js';
import { select, type SelectableAccount } from '../selector/selector.js';
import { markCapped, cappedNames, clearAccount } from '../ledger/ledger.js';
import type { Ledger } from '../ledger/ledger.schema.js';
import { launchHeadless, type HeadlessRunner } from './launcher.js';

/** An account the rotator can run: selectable plus its config dir. */
export interface RotatableAccount extends SelectableAccount {
  dir: string;
}

export interface AutoRotateDeps<T extends RotatableAccount> {
  claude: ClaudeInvoker;
  accounts: T[];
  loggedIn: Set<string>;
  pinned?: string;
  now: () => number;
  defaultBackoffMinutes: number;
  /** Starting ledger; threaded through and returned updated for the caller to persist. */
  ledger: Ledger;
  run?: HeadlessRunner;
  out: (message: string) => void;
  /** Emit the winning run's captured output (real CLI writes to std streams). */
  writeOutput?: (stdout: string, stderr: string) => void;
}

export interface AutoRotateResult {
  exitCode: number;
  account?: string;
  rotations: number;
  /** Updated ledger to persist. */
  ledger: Ledger;
}

/**
 * Run a headless request, hopping to the next healthy account each time the
 * current one reports a usage cap, until one succeeds or every account is
 * capped. The ledger is threaded through (never mutated in place) so the caller
 * persists exactly once.
 */
export async function autoRotateHeadless<T extends RotatableAccount>(
  args: string[],
  deps: AutoRotateDeps<T>,
): Promise<AutoRotateResult> {
  let ledger = deps.ledger;
  let rotations = 0;
  const maxAttempts = deps.accounts.length + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const capped = cappedNames(ledger, deps.now());
    const sel = select({ accounts: deps.accounts, loggedIn: deps.loggedIn, capped, pinned: deps.pinned });
    if (!sel.ok) {
      deps.out(`cannot run: ${sel.reason}`);
      return { exitCode: 1, rotations, ledger };
    }

    const account = sel.account;
    const headless = await launchHeadless(args, account, { claude: deps.claude, run: deps.run });
    const { classification } = headless;

    if (classification.kind === 'capped') {
      ledger = markCapped(ledger, {
        account: account.name,
        now: deps.now(),
        resetAt: classification.resetAt ?? null,
        backoffMinutes: deps.defaultBackoffMinutes,
        reason: classification.reason ?? 'usage cap',
      });
      rotations++;
      deps.out(`${account.name} is capped (${classification.reason ?? 'usage cap'}); rotating...`);
      continue;
    }

    if (classification.kind === 'ok') ledger = clearAccount(ledger, account.name);
    deps.writeOutput?.(headless.stdout, headless.stderr);
    return { exitCode: headless.exitCode, account: account.name, rotations, ledger };
  }

  deps.out('all accounts are capped; try again later');
  return { exitCode: 1, rotations, ledger };
}
