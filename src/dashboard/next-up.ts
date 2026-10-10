import { planRotation, type RotationPlan, type RotationStrategy } from '../usage/rotation-plan.js';
import { normalizeModel, type AccountModelUsage } from '../usage/model-preference.js';

/**
 * Where rotation will actually send this session, in words.
 *
 * The table says what every account HAS. This says what happens next, which is
 * the question the numbers are being read to answer and the one thing no other
 * tool can show: it needs the usage, the policy and the ledger together, and
 * only ccx has all three.
 *
 * Kept out of the renderer so that stays a pure function of what it is given,
 * and out of the planner so the planner keeps answering one question.
 */

export interface NextUpInput {
  /** Candidates in the order rotation would try them, already filtered. */
  candidates: AccountModelUsage[];
  /** The account running now, so "staying put" can be said as staying put. */
  current: string | null;
  modelInUse: string | null;
  preference: readonly string[];
  strategy: RotationStrategy;
  spentThisRun?: ReadonlySet<string>;
  /**
   * Why an account would be picked, in words, added after a move. Asked of
   * the account the plan names, so it always describes the one on the line.
   */
  reasonFor?: (account: string) => string | null;
}

/** The one plan both wordings below describe. */
function planFor(input: NextUpInput): RotationPlan {
  return planRotation({
    candidates: input.candidates,
    modelInUse: input.modelInUse,
    preference: input.preference,
    strategy: input.strategy,
    spentThisRun: input.spentThisRun ?? new Set<string>(),
  });
}

/** The same move as the dashboard says it, and the account it names. */
export interface WhenOut {
  /** The account a session would go to. Absent when there is nowhere to go. */
  account?: string;
  /** What follows "when one runs out" on the dashboard. */
  words: string;
}

/**
 * Where a session goes when its account runs out, in the dashboard's words.
 *
 * A second wording of the plan `describeNextUp` words, because that one is
 * read by other programs through `ccx state` and has to stay as it is. Here
 * `reasonFor` gives the reason as an aside, to go in brackets after the name,
 * and is asked even when the plan stays put: the line describes the account.
 */
export function describeWhenOut(input: NextUpInput): WhenOut | null {
  const plan = planFor(input);
  if (plan.kind === 'exhausted') return { words: plan.reason };
  if (!plan.model) return { account: plan.account, words: plan.account };

  const model = normalizeModel(plan.model);
  const named = `${model.charAt(0).toUpperCase()}${model.slice(1)}`;
  const room = roomLeft(input.candidates, plan.account, plan.model);
  const aside = input.reasonFor?.(plan.account) ?? (room === null ? null : `${room}% of ${named} left`);
  const where = plan.changedModel ? `${plan.account}, on ${named} instead` : plan.account;
  return { account: plan.account, words: aside ? `${where} (${aside})` : where };
}

export function describeNextUp(input: NextUpInput): string | null {
  const plan = planFor(input);

  if (plan.kind === 'exhausted') return plan.reason;
  if (!plan.model) return `${plan.account}`;

  const room = roomLeft(input.candidates, plan.account, plan.model);
  const staying = plan.account === input.current;
  const where = staying ? 'staying here' : `over on ${plan.account}`;
  const model = plan.changedModel ? `${plan.model} (changed)` : plan.model;
  const line = room === null ? `${where}, on ${model}` : `${where}, on ${model} (${room}% left)`;
  const reason = staying ? null : (input.reasonFor?.(plan.account) ?? null);
  return reason ? `${line} · ${reason}` : line;
}

/** How much of that model is still free on that account, as a whole percent. */
function roomLeft(
  candidates: AccountModelUsage[],
  account: string,
  model: string,
): number | null {
  const found = candidates.find((c) => c.name === account);
  if (!found) return null;
  const key = normalizeModel(model);
  const entry = Object.entries(found.models).find(([name]) => normalizeModel(name) === key);
  const used = entry?.[1];
  // Unmeasured is not zero. Saying "100% left" about a window nobody has read
  // would be a confident guess, and the honest answer is to say nothing.
  return typeof used === 'number' ? Math.max(0, Math.round((1 - used) * 100)) : null;
}
