/**
 * Choosing where to go next when the model you are on runs out.
 *
 * Rotation used to ask only "which account still works". That is the wrong
 * question when the limit is per model. If a session is on Fable and Fable runs
 * out on this account, the useful move is another account that still has Fable,
 * not any account at all, and certainly not one whose Fable is also spent.
 *
 * Only when NO account has room on the current model is it worth changing model,
 * and then it should be the next one you would actually want rather than
 * whatever happens to be free. Hence a preference order, defaulting to Fable
 * then Opus, and configurable because that order is a matter of taste.
 */

/** How much of a window must be left for it to count as usable. */
const ROOM = 0.999;

export interface AccountModelUsage {
  name: string;
  /** Per-model utilization, 0..1. A model missing here has not been read. */
  models: Record<string, number | null>;
  /** True when the whole account is out, whatever the model. */
  accountWideOut?: boolean;
}

/** Normalized so "Fable", "fable" and "claude-fable-5[1m]" are one thing. */
export function normalizeModel(model: string): string {
  const lower = model.toLowerCase();
  for (const known of ['fable', 'opus', 'sonnet', 'haiku']) {
    if (lower.includes(known)) return known;
  }
  return lower;
}

/** Does this account have room on `model` right now? */
export function hasRoomFor(account: AccountModelUsage, model: string): boolean {
  if (account.accountWideOut) return false;
  const key = normalizeModel(model);
  const entry = Object.entries(account.models).find(([name]) => normalizeModel(name) === key);
  // Unknown counts as room. Refusing to try an account nobody has measured would
  // strand a perfectly good one, and the worst case is one wasted attempt.
  if (!entry || entry[1] === null) return true;
  return (entry[1] as number) < ROOM;
}
