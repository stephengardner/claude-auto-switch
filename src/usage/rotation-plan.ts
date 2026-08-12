import { normalizeModel, hasRoomFor, type AccountModelUsage } from './model-preference.js';

/**
 * The one decision: what runs next, on which account, on which model.
 *
 * This used to be two decisions that disagreed with each other. Rotation asked
 * "which account still has room on this model" while the session separately
 * asked "this model ran out here, what is the next model", and the second one
 * fired first. So one account running out of Fable moved the whole run to Opus
 * even though another account had most of its Fable week left, and once that
 * happened nothing ever moved it back: the choice was remembered for the run,
 * not re-made per account. Measured on a real machine: ten rotations in six
 * minutes, ending on an account with 24% of its Fable still free, running Opus.
 *
 * One planner, one answer, and the operator picks the rule it follows:
 *
 *   model-first   Use up the CURRENT MODEL everywhere before changing model.
 *                 Fable on every account, then Opus on every account. This is
 *                 the default, and it is what "stay on Fable as long as
 *                 possible" means.
 *
 *   account-first Use up each ACCOUNT before moving to the next one. Fable
 *                 then Opus on this account, then the same on the next. For
 *                 when accounts are the scarce thing rather than models.
 *
 * Never falling back at all is expressed by a one-model chain
 * (`modelPreference: ['fable']`), which needs no special case here: the chain
 * simply runs out, and running out is reported honestly rather than papered
 * over with a model nobody asked for.
 */

export type RotationStrategy = 'model-first' | 'account-first';

export interface RotationPlanInput {
  /**
   * Accounts in the order rotation would otherwise try them: priority order
   * with the pinned account first, already filtered for enabled/logged-in/
   * account-wide-capped. Usage is per model, expired windows already dropped.
   */
  candidates: AccountModelUsage[];
  /** The model the session is running, or null when nothing pins one. */
  modelInUse: string | null;
  /** The fallback chain, in the operator's order. */
  preference: readonly string[];
  strategy: RotationStrategy;
  /**
   * "account|model" pairs proven spent during THIS run.
   *
   * Per account, deliberately. Held globally, one account's spent Fable read
   * as every account's spent Fable, which is the bug this file exists to end.
   */
  spentThisRun: ReadonlySet<string>;
}

export type RotationPlan =
  | {
      kind: 'run';
      account: string;
      /** Null means "whatever the session was already running"; nothing is imposed. */
      model: string | null;
      changedModel: boolean;
      /** Plain-language reason, for the log and for the operator. */
      reason: string;
    }
  | { kind: 'exhausted'; reason: string };

/** The key a spent (account, model) pair is remembered under. */
export function spentKey(account: string, model: string): string {
  return `${account}|${normalizeModel(model)}`;
}

/**
 * Where to go next.
 *
 * Returns the FIRST usable pairing under the chosen rule, so "first" is where
 * the policy lives and the two strategies differ only in which loop is outer.
 */
export function planRotation(input: RotationPlanInput): RotationPlan {
  const { candidates, strategy, spentThisRun } = input;
  if (candidates.length === 0) {
    return { kind: 'exhausted', reason: 'no account is available to run on' };
  }

  const chain = modelChain(input.modelInUse, input.preference);
  // Nothing pins a model, so Claude picks its own default and ccx cannot read
  // it. Choosing an account for some preference model's headroom would pick on
  // one model and run another, and imposing the preference would silently
  // change the model nobody asked to change. Plain account rotation is the
  // honest answer.
  if (input.modelInUse === null || chain.length === 0) {
    const first = candidates[0]!;
    return {
      kind: 'run',
      account: first.name,
      model: null,
      changedModel: false,
      reason: `running on "${first.name}"`,
    };
  }

  const usable = (account: AccountModelUsage, model: string): boolean =>
    !spentThisRun.has(spentKey(account.name, model)) && hasRoomFor(account, model);

  const pairs: Array<{ account: AccountModelUsage; model: string }> =
    strategy === 'model-first'
      ? chain.flatMap((model) => candidates.map((account) => ({ account, model })))
      : candidates.flatMap((account) => chain.map((model) => ({ account, model })));

  const hit = pairs.find(({ account, model }) => usable(account, model));
  if (!hit) {
    return {
      kind: 'exhausted',
      reason: `every account is out of ${chain.join(' and ')}`,
    };
  }

  const changedModel =
    input.modelInUse !== null && normalizeModel(hit.model) !== normalizeModel(input.modelInUse);
  return {
    kind: 'run',
    account: hit.account.name,
    model: hit.model,
    changedModel,
    reason: planReason(hit.account.name, hit.model, changedModel, input.modelInUse),
  };
}

/**
 * The models worth trying, current one first.
 *
 * The model in use leads even when it is not in the configured chain: it is
 * what the operator is actually running, and dropping it would move them off a
 * model that still has room just because it is not on a list.
 *
 * No model in use means NO chain, deliberately. Planning against the
 * preference then would be planning for a model the session is not running.
 */
function modelChain(modelInUse: string | null, preference: readonly string[]): string[] {
  if (!modelInUse) return [];
  const rest = preference.filter((m) => normalizeModel(m) !== normalizeModel(modelInUse));
  return [modelInUse, ...rest];
}

function planReason(
  account: string,
  model: string,
  changedModel: boolean,
  modelInUse: string | null,
): string {
  if (changedModel && modelInUse) {
    return `every account is out of ${modelInUse}; moving to ${model} on "${account}"`;
  }
  return `staying on ${model}, over on "${account}"`;
}
