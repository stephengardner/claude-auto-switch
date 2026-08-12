import type { ClaudeInvoker } from '../invoker.js';
import { select, type SelectableAccount } from '../selector/selector.js';
import { markCapped, cappedNames, clearAccount } from '../ledger/ledger.js';
import type { Ledger } from '../ledger/ledger.schema.js';
import type { CapDecision } from '../usage/confirm-cap.js';
import { nextModel } from '../usage/next-model.js';
import { withModel } from '../usage/model-args.js';
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
  /**
   * Confirm a cap against the account's OWN usage before recording it.
   *
   * Required rather than optional: an unverified cap takes an account out for
   * hours, so a call site must not be able to skip this by forgetting it.
   */
  confirmCap: (account: T, renderedText: string) => Promise<CapDecision>;
  /**
   * Model fallback order, the operator's `modelPreference` (default Fable then
   * Opus). Empty disables model fallback and rotates on accounts alone.
   */
  modelPreference?: string[];
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
  /**
   * Models proven spent during THIS run.
   *
   * A per-model limit stops the model, not the account, so the useful move is to
   * change model rather than to walk the accounts. Without this the loop kept
   * picking the same account and the same exhausted model until it ran out of
   * attempts and reported that everything was capped.
   */
  const spentModels: string[] = [];
  let runArgs = args;
  // Room for the whole preference chain on every account, or the loop gives up
  // before it has actually tried the fallbacks.
  const chain = deps.modelPreference ?? [];
  const maxAttempts = deps.accounts.length * Math.max(1, chain.length) + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const capped = cappedNames(ledger, deps.now());
    const sel = select({ accounts: deps.accounts, loggedIn: deps.loggedIn, capped, pinned: deps.pinned });
    if (!sel.ok) {
      deps.out(`cannot run: ${sel.reason}`);
      return { exitCode: 1, rotations, ledger };
    }

    const account = sel.account;
    const headless = await launchHeadless(runArgs, account, { claude: deps.claude, run: deps.run });
    const { classification } = headless;

    if (classification.kind === 'capped') {
      // Cap-looking text is a TRIGGER, never a verdict. This path used to write
      // the cap straight from the text, which meant any output matching the
      // patterns took an account out for hours, and a Fable-only limit took the
      // whole account out even though it still ran on every other model.
      const confirmed = await deps.confirmCap(account, classification.reason ?? '');
      if (!confirmed.limited) {
        // Not proven is not a cap. Returning the run's own result is the honest
        // outcome: whatever the text was, this account was not out of room.
        deps.out(
          `${account.name} printed limit-looking text, but it is not actually capped` +
            `${confirmed.detail ? ` (${confirmed.detail})` : ''}; not rotating`,
        );
        deps.writeOutput?.(headless.stdout, headless.stderr);
        return { exitCode: headless.exitCode, account: account.name, rotations, ledger };
      }
      ledger = markCapped(ledger, {
        account: account.name,
        now: deps.now(),
        resetAt: confirmed.resetAt ?? classification.resetAt ?? null,
        backoffMinutes: deps.defaultBackoffMinutes,
        reason: confirmed.detail ?? classification.reason ?? 'usage cap',
        // Carried so a model-scoped limit never blocks the whole account.
        ...(confirmed.model ? { model: confirmed.model } : {}),
      });
      rotations++;

      // A model-scoped limit: change MODEL and stay here. The account still has
      // room, so rotating away from it would be giving up something that works.
      if (confirmed.model) {
        if (!spentModels.some((m) => m.toLowerCase() === confirmed.model!.toLowerCase())) {
          spentModels.push(confirmed.model);
        }
        const fallback = nextModel(chain, spentModels);
        if (fallback) {
          runArgs = withModel(runArgs, fallback);
          deps.out(
            `${account.name} is out of ${confirmed.model}; switching to ${fallback} and carrying on...`,
          );
          continue;
        }
        deps.out(`${account.name} is out of ${confirmed.model} and there is no other model left to try`);
        continue;
      }

      deps.out(`${account.name} is out of room; rotating...`);
      continue;
    }

    if (classification.kind === 'ok') ledger = clearAccount(ledger, account.name);
    deps.writeOutput?.(headless.stdout, headless.stderr);
    return { exitCode: headless.exitCode, account: account.name, rotations, ledger };
  }

  deps.out('all accounts are capped; try again later');
  return { exitCode: 1, rotations, ledger };
}
