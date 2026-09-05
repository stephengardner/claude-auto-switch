import type { PathCtx } from '../config/paths.js';
import { readUsageSnapshot } from './usage-store.js';
import { remainingRoom } from './usable-capacity.js';

/**
 * A `roomOf(name)` for the selector's `most-room` order, built from the cached
 * usage snapshot. Read once here so a single sort does not re-read the file per
 * comparison. An account absent from the snapshot reads as fully open (1), which
 * `remainingRoom` already returns for missing data, so a brand-new account sorts
 * as the least-used, which is what it is.
 */
export function roomOfFromSnapshot(
  ctx: PathCtx,
  now: number = Date.now(),
): (name: string) => number {
  const snapshot = readUsageSnapshot(ctx);
  return (name: string) => remainingRoom(snapshot.accounts[name], now);
}
