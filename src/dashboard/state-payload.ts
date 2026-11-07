import { accountStatus } from './account-status.js';
import type { AccountStanding, DashboardSnapshot, RotationValues } from './render.js';

/**
 * ccx's state, for something other than a terminal to read.
 *
 * The dashboard's snapshot is already a render-agnostic view of everything ccx
 * knows, so this is that same snapshot in a shape a program can depend on
 * rather than a shape a terminal can paint. Built the same way the live screen is,
 * which is the point: a second surface deciding these things for itself would
 * drift from the first, and it would drift on exactly the thing that matters,
 * which account can be used right now. Each call is still a snapshot of its
 * own moment; what is shared is the rules, not the reading.
 *
 * The derived status travels WITH the numbers on purpose. A consumer that
 * re-derived "is this account usable" from the raw windows would be
 * reimplementing a rule that has already been got wrong once in this codebase:
 * the table said `ready` beside a window reading 100% while rotation refused
 * to touch that account. Ship the answer, not just the inputs.
 *
 * The same goes for everything else the screen works out: where each account
 * stands in the pick order and why, its runway, whether its week holds it
 * back, the sessions running, what happens when the active account runs out,
 * and the settings that decided all of it. Each is carried as values rather
 * than as the screen's words, so a reader never parses prose ccx may reword.
 */

/** Bump when a field changes meaning or leaves. Additions do not need it. */
export const STATE_SCHEMA_VERSION = 1;

/** Where an account stands for the next move, by the runway rule (usage/runway.ts). */
export interface StateRunway {
  /** Work it can do before a window stops it, in full 5-hour windows (0..1). */
  windows: number;
  /** Which window stops it first; `none` when nothing would within a window. */
  binding: AccountStanding['binding'];
  /** Weekly budget left, in full 5-hour windows of work; null when not measured. */
  weeklyWindowsLeft: number | null;
  /** Share of the week left (0..1), the tighter of the account's and the model's own; null when not measured. */
  weekLeft: number | null;
  /** Enough runway to be worth moving a session onto. */
  worthMoving: boolean;
}

export interface StateAccount {
  name: string;
  email?: string;
  plan?: string;
  loggedIn: boolean;
  /**
   * Signed out because Anthropic put the account on hold (its login was
   * refused with `account_on_hold`); signing in again does not bring it back.
   */
  onHold: boolean;
  enabled: boolean;
  active: boolean;
  priority: number;
  /** Its tags (accounts/tags); empty when it has none. */
  tags: string[];
  /** Its profile folder: the CLAUDE_CONFIG_DIR a session on it reads its login from. */
  configDir?: string;
  /**
   * When its login was checked (epoch ms). This read's own probe, or with
   * `--cached-logins` a remembered check no older than the bound asked for.
   */
  loginCheckedAt?: number;
  /** Epoch ms ccx recorded this account as capped until, if it did. */
  cappedUntil?: number;
  usage?: DashboardSnapshot['accounts'][number]['usage'];
  /** Where it stands for the next move. Null only for an account the snapshot has no reading of at all. */
  runway: StateRunway | null;
  /** Its week is nearly spent (rotation.holdBackAtPercent), so rotation picks it after healthier accounts. */
  heldBack: boolean;
  /**
   * Its place in the order rotation picks from: rank 1 is the next pick, and
   * `binding` the window that would stop it. Null for an account rotation
   * would not pick now (disabled, signed out, capped, or unable to run the
   * model chain).
   */
  pick: { rank: number; binding: AccountStanding['binding'] } | null;
  status: {
    /** ready | blocked | disabled | logged-out | on-hold */
    state: string;
    /** What is being named: a model, `5h`, `week`, `capped`. Null when ready. */
    label: string | null;
    /** Epoch ms it can be used again, when that is known. */
    until: number | null;
    /** Everything blocking it, not only the one named. */
    blockedBy: Array<{ label: string; until?: number | null }>;
  };
}

/** A ccx session running now (session/lease.ts): one per process, its freshest lease, in pid order. */
export interface StateSession {
  pid: number;
  /** The account it is on. */
  account: string;
  /** The folder it was started in, when its lease says. */
  cwd?: string;
  /** The config folder it reads its login from. */
  configDir?: string;
  /** When it last said it was still going (epoch ms). */
  lastSeen?: number;
}

export interface StatePayload {
  schemaVersion: number;
  /** Which ccx produced this, so a reader can tell old data from new. */
  ccxVersion?: string;
  /** When it was taken. Every `until` is an absolute epoch ms against this. */
  now: number;
  /** The account ccx would use, and the model it prefers. */
  active: string | null;
  preferredModel: string | null;
  /** Where rotation goes next, in words. Null when nothing pins a model. */
  nextUp: string | null;
  /**
   * Where a session goes when the account it is on runs out, the move the
   * screen words under its table: the account (null when no account has room),
   * the model it would run there (null when nothing pins one), and whether that
   * means changing model. Null when there is nothing to plan for.
   */
  whenOut: { account: string | null; model: string | null; changesModel: boolean } | null;
  /** The rotation settings in force, as values. */
  settings: RotationValues | null;
  accounts: StateAccount[];
  /** The ccx sessions running now; empty when none. */
  sessions: StateSession[];
  /** Recent activity, newest last, already formatted for reading. */
  events: string[];
}

/** Turn the dashboard's snapshot into the published shape. */
export function toStatePayload(snapshot: DashboardSnapshot): StatePayload {
  const model = snapshot.model ?? null;
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    ...(snapshot.version ? { ccxVersion: snapshot.version } : {}),
    now: snapshot.now,
    active: snapshot.accounts.find((a) => a.active)?.name ?? null,
    preferredModel: model,
    nextUp: snapshot.nextUp ?? null,
    whenOut: snapshot.whenOut
      ? {
          account: snapshot.whenOut.account ?? null,
          model: snapshot.whenOut.model ?? null,
          changesModel: snapshot.whenOut.changesModel === true,
        }
      : null,
    settings: snapshot.rotation ?? null,
    accounts: snapshot.accounts.map((a) => {
      const status = accountStatus(a, model, snapshot.now);
      const standing = a.standing;
      return {
        name: a.name,
        ...(a.email !== undefined ? { email: a.email } : {}),
        ...(a.plan !== undefined ? { plan: a.plan } : {}),
        loggedIn: a.loggedIn,
        onHold: a.onHold === true,
        enabled: a.enabled,
        active: a.active,
        priority: a.priority,
        tags: a.tags ?? [],
        ...(a.configDir !== undefined ? { configDir: a.configDir } : {}),
        ...(a.loginCheckedAt !== undefined ? { loginCheckedAt: a.loginCheckedAt } : {}),
        ...(a.cappedUntil !== undefined ? { cappedUntil: a.cappedUntil } : {}),
        ...(a.usage !== undefined ? { usage: a.usage } : {}),
        runway: standing
          ? {
              windows: standing.runway,
              binding: standing.binding,
              weeklyWindowsLeft: standing.weeklyWindowsLeft,
              weekLeft: standing.weekLeft,
              worthMoving: standing.worthMoving,
            }
          : null,
        heldBack: standing?.heldBack ?? a.pick?.heldBack !== undefined,
        pick: a.pick ? { rank: a.pick.rank, binding: a.pick.binding } : null,
        status: {
          state: status.state,
          label: status.label,
          until: status.until,
          blockedBy: status.constraints,
        },
      };
    }),
    sessions: (snapshot.sessions ?? []).flatMap((s) =>
      typeof s.pid === 'number'
        ? [
            {
              pid: s.pid,
              account: s.account,
              ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
              ...(s.configDir !== undefined ? { configDir: s.configDir } : {}),
              ...(s.lastSeen !== undefined ? { lastSeen: s.lastSeen } : {}),
            },
          ]
        : [],
    ),
    events: snapshot.events,
  };
}
