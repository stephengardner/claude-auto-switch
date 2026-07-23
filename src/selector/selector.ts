/** Minimal account shape the selector reasons over (registry Account satisfies this). */
export interface SelectableAccount {
  name: string;
  priority: number;
  enabled: boolean;
}

export interface SelectInput<T extends SelectableAccount = SelectableAccount> {
  accounts: T[];
  /** Names currently logged in. */
  loggedIn: Set<string>;
  /** Names currently rate-limited (empty in Phase 1; filled by the ledger in Phase 2). */
  capped: Set<string>;
  /** A manually pinned account; used if it is still eligible. */
  pinned?: string;
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
  const { accounts, loggedIn, capped, pinned } = input;
  const eligible = accounts.filter(
    (a) => a.enabled && loggedIn.has(a.name) && !capped.has(a.name),
  );

  if (eligible.length === 0) {
    return { ok: false, reason: explain(input) };
  }

  if (pinned !== undefined) {
    const pinnedAccount = eligible.find((a) => a.name === pinned);
    if (pinnedAccount) return { ok: true, account: pinnedAccount };
  }

  const best = eligible.reduce((current, candidate) =>
    isBetter(candidate, current) ? candidate : current,
  );
  return { ok: true, account: best };
}

/** Lower priority number wins; ties broken by name ascending. */
function isBetter(candidate: SelectableAccount, current: SelectableAccount): boolean {
  if (candidate.priority !== current.priority) {
    return candidate.priority < current.priority;
  }
  return candidate.name.localeCompare(current.name) < 0;
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
