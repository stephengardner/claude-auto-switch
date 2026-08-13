import { planRotation, type RotationStrategy } from '../usage/rotation-plan.js';
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
}

export function describeNextUp(input: NextUpInput): string | null {
  const plan = planRotation({
    candidates: input.candidates,
    modelInUse: input.modelInUse,
    preference: input.preference,
    strategy: input.strategy,
    spentThisRun: input.spentThisRun ?? new Set<string>(),
  });

  if (plan.kind === 'exhausted') return plan.reason;
  if (!plan.model) return `${plan.account}`;

  const room = roomLeft(input.candidates, plan.account, plan.model);
  const where = plan.account === input.current ? 'staying here' : `over on ${plan.account}`;
  const model = plan.changedModel ? `${plan.model} (changed)` : plan.model;
  return room === null
    ? `${where}, on ${model}`
    : `${where}, on ${model} (${room}% left)`;
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
