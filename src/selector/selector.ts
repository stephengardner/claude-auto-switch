/** Minimal account shape the selector reasons over (registry Account satisfies this). */
export interface SelectableAccount {
  name: string;
  priority: number;
  enabled: boolean;
}

/**
 * How eligible accounts are ordered.
 * - `priority`: lowest `priority` number first (ties by name) - the classic order.
 * - `most-room`: the account with the most remaining headroom first (the
 *   least-used one), ties broken by priority then name. Needs `roomOf`.
 */
export type AccountOrder = 'priority' | 'most-room';

export interface SelectInput<T extends SelectableAccount = SelectableAccount> {
  accounts: T[];
  /** Names currently logged in. */
  loggedIn: Set<string>;
  /** Names currently rate-limited (empty in Phase 1; filled by the ledger in Phase 2). */
  capped: Set<string>;
  /** A manually pinned account; used if it is still eligible. */
  pinned?: string;
  /** Ordering policy for eligible accounts. Defaults to `priority`. */
  order?: AccountOrder;
  /**
   * Remaining headroom 0..1 for an account (higher = less used), used by the
   * `most-room` order. Omitted (or returning the same for all) falls back to
   * priority ordering, so a caller with no usage data keeps the classic order.
   */
  roomOf?: (name: string) => number;
}

export type SelectResult<T extends SelectableAccount = SelectableAccount> =
  | { ok: true; account: T }
  | { ok: false; reason: string };

/**
 * Pure active-account policy: pick an enabled, logged-in, non-capped account.
 * A pinned account wins when still eligible; otherwise the lowest `priority`
 * (ties broken by name). Generic so it returns the caller's full account type
 * (e.g. a registry Account with its `dir`), not just the minimal shape.
 */
export function select<T extends SelectableAccount>(input: SelectInput<T>): SelectResult<T> {
  const ordered = eligibleInOrder(input);
  const best = ordered[0];
  return best ? { ok: true, account: best } : { ok: false, reason: explain(input) };
}

/**
 * Every account that could run, in the order this policy would try them.
 *
 * `select` is the first of these. Callers that must choose among several (the
 * rotation planner needs the whole list, because the best account depends on
 * which model still has room) take the list instead of re-deriving eligibility
 * themselves. One definition, so a second copy cannot drift from it.
 */
export function eligibleInOrder<T extends SelectableAccount>(input: SelectInput<T>): T[] {
  const { accounts, loggedIn, capped, pinned } = input;
  const eligible = accounts.filter((a) => a.enabled && loggedIn.has(a.name) && !capped.has(a.name));
  const cmp = orderComparator<T>(input.order ?? 'priority', input.roomOf);
  const sorted = [...eligible].sort(cmp);
  if (pinned === undefined) return sorted;
  const pinnedAccount = sorted.find((a) => a.name === pinned);
  // A pinned account leads when it is still eligible; the rest keep their order
  // behind it, so rotation past the pin is still the chosen order.
  return pinnedAccount ? [pinnedAccount, ...sorted.filter((a) => a !== pinnedAccount)] : sorted;
}

/**
 * Sort order for eligible accounts.
 *
 * `most-room` puts the account with the most remaining headroom first (the
 * least-used one); when two are equally roomy, or `roomOf` is not provided, it
 * falls through to the classic priority-then-name tiebreak, so the order is
 * always fully determined and a caller without usage data behaves as before.
 */
export function orderComparator<T extends SelectableAccount>(
  order: AccountOrder,
  roomOf: ((name: string) => number) | undefined,
): (a: T, b: T) => number {
  return (a, b) => {
    if (order === 'most-room' && roomOf) {
      const diff = roomOf(b.name) - roomOf(a.name); // more room first
      if (diff !== 0) return diff;
    }
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.name.localeCompare(b.name);
  };
}

/** Explain why no account is eligible, most-specific reason first. */
function explain<T extends SelectableAccount>(input: SelectInput<T>): string {
  const { accounts, loggedIn, capped } = input;
  if (accounts.length === 0) return 'no accounts registered (run: ccx add <name>)';

  const enabled = accounts.filter((a) => a.enabled);
  if (enabled.length === 0) return 'all accounts are disabled';

  const enabledLoggedIn = enabled.filter((a) => loggedIn.has(a.name));
  if (enabledLoggedIn.length === 0) return 'no enabled account is logged in (run: ccx login --all)';

  if (enabledLoggedIn.every((a) => capped.has(a.name))) {
    return 'all logged-in accounts are currently capped';
  }
  return 'no eligible account available';
}
