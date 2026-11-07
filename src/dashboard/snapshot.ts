import type {
  AccountStanding,
  DashboardAccount,
  DashboardSession,
  DashboardSettings,
  DashboardSnapshot,
  RotationValues,
} from './render.js';

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
    tags?: string[];
    /** The pool it is drawn from (accounts/pools). */
    pool?: string;
    /** Its profile folder (the registry's `dir`). */
    dir?: string;
  }>;
  /** Names currently logged in (from the health probe). */
  loggedIn: Set<string>;
  /** Names whose login was refused because Anthropic put the account on hold. */
  onHold?: Set<string>;
  /** Live email/plan from the health probe, overriding the cached registry values. */
  liveEmail?: Map<string, string>;
  livePlan?: Map<string, string>;
  /** Account name -> epoch ms it is capped until. */
  cappedUntil: Map<string, number>;
  /** Account name -> subscription usage (0..1 utilization per window). */
  usage?: Map<
    string,
    {
      fiveHour: number | null;
      sevenDay: number | null;
      fiveHourReset?: number | null;
      sevenDayReset?: number | null;
      models?: Array<{ name: string; utilization: number; resetsAt?: number | null }> | null;
      /** The last successful read (see DashboardAccount). */
      readAt?: number | null;
      windowCost?: number | null;
      /** No 5-hour limit on this account (see DashboardAccount). */
      noFiveHourLimit?: boolean;
    }
  >;
  active: string | null;
  events: string[];
  now: number;
  refreshMs: number;
  /** The model in use, when anything pins one. */
  model?: string;
  /** Which ccx is drawing this. */
  version?: string;
  /** Where rotation would go next, in words. See dashboard/next-up.ts. */
  nextUp?: string;
  /** The same move in the screen's words, and the account it names. */
  whenOut?: DashboardSnapshot['whenOut'] | null;
  /** The plan without the active account (see DashboardSnapshot). */
  afterActive?: DashboardSnapshot['afterActive'];
  /** Claude Desktop's line and keys. See desktop/summary.ts. */
  desktop?: { line: string; keys: string } | null;
  /** Where each account stands in the pick order (see dashboard.ts nextMove). */
  picks?: Map<string, NonNullable<DashboardAccount['pick']>>;
  /** The rotation settings, in words. */
  settings?: DashboardSettings;
  /** The ccx sessions running now. */
  sessions?: DashboardSession[];
  /** Account name -> when its login was checked (epoch ms). */
  loginCheckedAt?: Map<string, number>;
  /** Account name -> where it stands for the next move, for every account (see dashboard.ts nextMove). */
  standings?: Map<string, AccountStanding>;
  /** The rotation settings as values. */
  rotation?: RotationValues;
}

export function toSnapshot(input: SnapshotInput): DashboardSnapshot {
  const accounts: DashboardAccount[] = input.accounts
    .map((a) => {
      const cap = input.cappedUntil.get(a.name);
      const usage = input.usage?.get(a.name);
      const pick = input.picks?.get(a.name);
      const standing = input.standings?.get(a.name);
      const checkedAt = input.loginCheckedAt?.get(a.name);
      return {
        name: a.name,
        email: input.liveEmail?.get(a.name) ?? a.email,
        plan: input.livePlan?.get(a.name) ?? a.plan,
        loggedIn: input.loggedIn.has(a.name),
        ...(input.onHold?.has(a.name) ? { onHold: true } : {}),
        active: input.active === a.name,
        enabled: a.enabled,
        priority: a.priority,
        ...(a.tags && a.tags.length > 0 ? { tags: a.tags } : {}),
        ...(cap !== undefined ? { cappedUntil: cap } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(pick !== undefined ? { pick } : {}),
        ...(a.pool !== undefined ? { pool: a.pool } : {}),
        ...(a.dir !== undefined ? { configDir: a.dir } : {}),
        ...(checkedAt !== undefined ? { loginCheckedAt: checkedAt } : {}),
        ...(standing !== undefined ? { standing } : {}),
      };
    })
    // Stable, meaningful order: preferred (lowest priority) first, ties by name.
    .sort((x, y) => x.priority - y.priority || x.name.localeCompare(y.name));

  return {
    accounts,
    events: input.events,
    now: input.now,
    refreshMs: input.refreshMs,
    ...(input.model ? { model: input.model } : {}),
    ...(input.version ? { version: input.version } : {}),
    ...(input.nextUp ? { nextUp: input.nextUp } : {}),
    ...(input.whenOut ? { whenOut: input.whenOut } : {}),
    ...(input.afterActive !== undefined ? { afterActive: input.afterActive } : {}),
    ...(input.desktop ? { desktop: input.desktop } : {}),
    ...(input.settings ? { settings: input.settings } : {}),
    ...(input.sessions && input.sessions.length > 0 ? { sessions: input.sessions } : {}),
    ...(input.rotation ? { rotation: input.rotation } : {}),
  };
}
