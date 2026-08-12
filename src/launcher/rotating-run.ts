import type { ClaudeInvoker } from '../invoker.js';
import { select, eligibleInOrder, type SelectableAccount } from '../selector/selector.js';
import { planRotation, spentKey, type RotationStrategy } from '../usage/rotation-plan.js';
import { modelInArgs } from '../usage/model-args.js';
import { markCapped, cappedNames, clearAccount } from '../ledger/ledger.js';
import type { Ledger } from '../ledger/ledger.schema.js';
import type { CapDecision } from '../usage/confirm-cap.js';
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
  /**
   * Which runs out first, the model or the account. Same setting the
   * interactive path follows, so `ccx models` means one thing everywhere: a
   * strategy that governed only one of the two ways to run is a setting that
   * lies about what it does.
   */
  modelStrategy?: RotationStrategy;
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
   * "account|model" pairs proven spent during THIS run.
   *
   * Per account, like the interactive path: one account running out of a model
   * says nothing about another account's window, and holding it as a bare list
   * of models is what moved a whole run off a model that other accounts still
   * had. Each confirmed limit removes exactly one pairing, which is also what
   * bounds the loop.
   */
  const spentThisRun = new Set<string>();
  /**
   * The model in use, once something has told us what it is. A confirmed cap
   * names it even when the operator passed no `--model`, and without that the
   * first rotation is blind.
   */
  let modelInUse: string | null = modelInArgs(args);
  let runArgs = args;
  // Room for the whole preference chain on every account, or the loop gives up
  // before it has actually tried the fallbacks.
  const chain = deps.modelPreference ?? [];
  const maxAttempts = deps.accounts.length * Math.max(1, chain.length) + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const capped = cappedNames(ledger, deps.now());
    const selectInput = {
      accounts: deps.accounts,
      loggedIn: deps.loggedIn,
      capped,
      ...(deps.pinned !== undefined ? { pinned: deps.pinned } : {}),
    };
    const sel = select(selectInput);
    if (!sel.ok) {
      deps.out(`cannot run: ${sel.reason}`);
      return { exitCode: 1, rotations, ledger };
    }

    // The account AND the model, decided together, by the same planner the
    // interactive path uses. Usage numbers are not read here: an unmeasured
    // model counts as room worth trying, and the pairs proven spent during
    // this run are the evidence that accumulates. So `model-first` walks the
    // accounts on one model before falling back, and `account-first` walks the
    // models on one account, exactly as configured.
    const ordered = eligibleInOrder(selectInput);
    const plan = planRotation({
      candidates: ordered.map((a) => ({ name: a.name, models: {} })),
      modelInUse,
      preference: chain,
      strategy: deps.modelStrategy ?? 'model-first',
      spentThisRun,
    });
    if (plan.kind === 'exhausted') break;

    const account = ordered.find((a) => a.name === plan.account) ?? sel.account;
    if (plan.model) {
      if (plan.changedModel) deps.out(plan.reason);
      runArgs = withModel(args, plan.model);
      modelInUse = plan.model;
    }
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

      // A model-scoped limit stops that MODEL on THIS account. It is recorded
      // as one pairing and handed back to the planner, which decides whether
      // the next attempt is the same model somewhere else or another model
      // here. Deciding it inline was what made this path ignore the strategy.
      if (confirmed.model) {
        spentThisRun.add(spentKey(account.name, confirmed.model));
        // What the model in use actually was, whatever the flags said: this is
        // often the only place it is known, since a headless run without
        // `--model` is on Claude's default.
        modelInUse = modelInUse ?? confirmed.model;
        deps.out(`${account.name} is out of ${confirmed.model}...`);
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
