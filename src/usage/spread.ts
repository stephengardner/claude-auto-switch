/**
 * Spread workers across accounts.
 *
 * The pick order ranks accounts by how long each can run, but says nothing
 * about how many sessions are already running on it. An orchestrator that
 * starts five workers at once would put all five on the same best account,
 * which then runs out five times as fast. So a worker reaches first for a
 * healthy account no other session is using, then a healthy one that is in
 * use, then the rest, each group kept in the pick order. Healthy is the pick
 * order's own: worth moving to, its week not held back, and room for at least
 * half a 5-hour window. An account that is free but nearly spent never jumps
 * ahead of a healthy one that is busy.
 */
export function spreadWorkers<T extends { name: string }>(
  ordered: readonly T[],
  inUse: (name: string) => boolean,
  healthy: (name: string) => boolean,
): T[] {
  const freeHealthy: T[] = [];
  const busyHealthy: T[] = [];
  const rest: T[] = [];
  for (const account of ordered) {
    if (!healthy(account.name)) rest.push(account);
    else if (inUse(account.name)) busyHealthy.push(account);
    else freeHealthy.push(account);
  }
  return [...freeHealthy, ...busyHealthy, ...rest];
}
