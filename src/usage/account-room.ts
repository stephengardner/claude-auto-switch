import type { PathCtx } from '../config/paths.js';
import type { AccountOrder } from '../selector/selector.js';
import { readUsageSnapshot } from './usage-store.js';
import { remainingRoom } from './usable-capacity.js';
import { DEFAULT_HOLD_BACK_PERCENT, pickScore, standingOf } from './runway.js';

/** The settings that decide the pick order, as `config.rotation` holds them. */
export interface PickPolicy {
  accountOrder: AccountOrder;
  /** Under `smart`, how full a week holds an account back (see usage/runway.ts). */
  holdBackAtPercent?: number;
}

/**
 * A `roomOf(name)` for the selector's order, built from the cached usage
 * snapshot. Read once here so a single sort does not re-read the file per
 * comparison.
 *
 * For `smart` it is the pick score (usage/runway.ts), for `model` when one is
 * known, since a model with a weekly window of its own counts that too, with
 * nearly spent weeks held back. Otherwise it is the plain remaining room the
 * `most-room` order sorts by. An account absent from the snapshot reads as
 * fully open either way, so a brand-new account sorts as the least-used, which
 * is what it is.
 *
 * Takes the whole policy rather than the order alone, so a setting added to it
 * reaches every caller without each one having to pass it on.
 */
export function roomOfFromSnapshot(
  ctx: PathCtx,
  now: number = Date.now(),
  policy: PickPolicy = { accountOrder: 'most-room' },
  model?: string | null,
): (name: string) => number {
  const snapshot = readUsageSnapshot(ctx);
  if (policy.accountOrder === 'smart') {
    const holdBack = policy.holdBackAtPercent ?? DEFAULT_HOLD_BACK_PERCENT;
    return (name: string) => pickScore(standingOf(snapshot.accounts[name], now, model, holdBack));
  }
  return (name: string) => remainingRoom(snapshot.accounts[name], now);
}

/**
 * The model a session will most likely run when none is known yet: the first
 * preference, unless rotation is told to ignore models.
 */
export function preferredModel(context: {
  config: { rotation: { preferSameModel: boolean; modelPreference: readonly string[] } };
}): string | null {
  const { rotation } = context.config;
  return rotation.preferSameModel ? (rotation.modelPreference[0] ?? null) : null;
}
