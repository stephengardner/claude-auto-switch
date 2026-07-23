import type { DashboardAccount, DashboardSnapshot } from './render.js';

/**
 * Pure mapping from the tool's own data (registry + health probe + ledger +
 * active pointer) into a dashboard snapshot. Kept separate from the live loop
 * so the mapping is fully testable without any I/O.
 */
export interface SnapshotInput {
  accounts: Array<{
    name: string;
    email?: string;
    plan?: string;
    enabled: boolean;
    priority: number;
  }>;
  /** Names currently logged in (from the health probe). */
  loggedIn: Set<string>;
  /** Live email/plan from the health probe, overriding the cached registry values. */
  liveEmail?: Map<string, string>;
  livePlan?: Map<string, string>;
  /** Account name -> epoch ms it is capped until. */
  cappedUntil: Map<string, number>;
  active: string | null;
  events: string[];
  now: number;
  refreshMs: number;
}

export function toSnapshot(input: SnapshotInput): DashboardSnapshot {
  const accounts: DashboardAccount[] = input.accounts
    .map((a) => {
      const cap = input.cappedUntil.get(a.name);
      return {
        name: a.name,
        email: input.liveEmail?.get(a.name) ?? a.email,
        plan: input.livePlan?.get(a.name) ?? a.plan,
        loggedIn: input.loggedIn.has(a.name),
        active: input.active === a.name,
        enabled: a.enabled,
        priority: a.priority,
        ...(cap !== undefined ? { cappedUntil: cap } : {}),
      };
    })
    // Stable, meaningful order: preferred (lowest priority) first, ties by name.
    .sort((x, y) => x.priority - y.priority || x.name.localeCompare(y.name));

  return { accounts, events: input.events, now: input.now, refreshMs: input.refreshMs };
}
