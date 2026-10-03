import type { PathCtx } from '../config/paths.js';
import type { AccountOrder } from '../selector/selector.js';
import { readUsageSnapshot } from './usage-store.js';
import { remainingRoom } from './usable-capacity.js';
import { pickScore, standingOf } from './runway.js';

/**
 * A `roomOf(name)` for the selector's order, built from the cached usage
 * snapshot. Read once here so a single sort does not re-read the file per
 * comparison.
 *
 * For `smart` it is the pick score (usage/runway.ts), for `model` when one is
 * known, since a model with a weekly window of its own is limited by that too.
 * Otherwise it is the plain remaining room the `most-room` order sorts by. An
 * account absent from the snapshot reads as fully open either way, so a
 * brand-new account sorts as the least-used, which is what it is.
 */
export function roomOfFromSnapshot(
  ctx: PathCtx,
  now: number = Date.now(),
  order: AccountOrder = 'most-room',
  model?: string | null,
): (name: string) => number {
  const snapshot = readUsageSnapshot(ctx);
  if (order === 'smart') {
    return (name: string) => pickScore(standingOf(snapshot.accounts[name], now, model));
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
