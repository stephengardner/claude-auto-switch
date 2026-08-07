/**
 * Which model to try when the one in use has run out.
 *
 * A per-model limit stops that MODEL, not the account. So the useful move is to
 * change model and carry on, not to give up on an account that still has most of
 * its week left. Rotating to another account instead solves nothing when every
 * account shares the same spent model, which is exactly the case that ended with
 * "every account has hit its limit" on an account with 94% of its five-hour
 * window free.
 *
 * The order is the operator's `modelPreference` (default Fable then Opus), so
 * the fallback is predictable rather than whatever happens to be free.
 */

/** Compared case-insensitively, since "Fable" on the wire is "fable" in config. */
const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The next model in the chain that has not been used up, or null when the chain
 * is finished and there is genuinely nothing left to try.
 */
export function nextModel(chain: readonly string[], exhausted: readonly string[]): string | null {
  const spent = (model: string): boolean => exhausted.some((e) => same(e, model));
  return chain.find((model) => !spent(model)) ?? null;
}
