import { accountStatus } from './account-status.js';
import type { DashboardSnapshot } from './render.js';

/**
 * ccx's state, for something other than a terminal to read.
 *
 * The dashboard's snapshot is already a render-agnostic view of everything ccx
 * knows, so this is that same snapshot in a shape a program can depend on
 * rather than a shape a terminal can paint. Built from the identical data the
 * live screen is built from, which is the point: a second surface that
 * assembled its own view would drift from the first, and it would drift on
 * exactly the thing that matters, which account can be used right now.
 *
 * The derived status travels WITH the numbers on purpose. A consumer that
 * re-derived "is this account usable" from the raw windows would be
 * reimplementing a rule that has already been got wrong once in this codebase:
 * the table said `ready` beside a window reading 100% while rotation refused
 * to touch that account. Ship the answer, not just the inputs.
 */

/** Bump when a field changes meaning or leaves. Additions do not need it. */
export const STATE_SCHEMA_VERSION = 1;

export interface StateAccount {
  name: string;
  email?: string;
  plan?: string;
  loggedIn: boolean;
  enabled: boolean;
  active: boolean;
  priority: number;
  /** Epoch ms ccx recorded this account as capped until, if it did. */
  cappedUntil?: number;
  usage?: DashboardSnapshot['accounts'][number]['usage'];
  status: {
    /** ready | blocked | disabled | logged-out */
    state: string;
    /** What is being named: a model, `5h`, `week`, `capped`. Null when ready. */
    label: string | null;
    /** Epoch ms it can be used again, when that is known. */
    until: number | null;
    /** Everything blocking it, not only the one named. */
    blockedBy: Array<{ label: string; until?: number | null }>;
  };
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
  accounts: StateAccount[];
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
    accounts: snapshot.accounts.map((a) => {
      const status = accountStatus(a, model, snapshot.now);
      return {
        name: a.name,
        ...(a.email !== undefined ? { email: a.email } : {}),
        ...(a.plan !== undefined ? { plan: a.plan } : {}),
        loggedIn: a.loggedIn,
        enabled: a.enabled,
        active: a.active,
        priority: a.priority,
        ...(a.cappedUntil !== undefined ? { cappedUntil: a.cappedUntil } : {}),
        ...(a.usage !== undefined ? { usage: a.usage } : {}),
        status: {
          state: status.state,
          label: status.label,
          until: status.until,
          blockedBy: status.constraints,
        },
      };
    }),
    events: snapshot.events,
  };
}
