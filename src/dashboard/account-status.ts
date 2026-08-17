import { effectiveUtilization } from '../usage/window-open.js';
import { normalizeModel } from '../usage/model-preference.js';
import type { DashboardAccount } from './render.js';

/**
 * Whether an account can be used right now, and if not, what is stopping it.
 *
 * Lives on its own because more than one surface answers this question: the
 * terminal dashboard draws it, and `ccx state` hands it to whatever is reading
 * ccx from outside. The last time two places worked out the same thing
 * separately they drifted, and the table ended up printing "ready" beside a
 * window reading 100% while rotation refused to use that account. So the rule
 * is written once and both callers take the answer rather than recomputing it.
 *
 * The rule itself: a window is spent at 100% while it is still open, which is
 * exactly `usableCapacity`'s test, so this can never disagree with the planner
 * either.
 */

export interface Constraint {
  /** `capped`, `5h`, `week`, or a model name. */
  label: string;
  /** When it lifts, if that is known. */
  until?: number | null;
}

export type AccountState =
  /** Nothing is stopping it. */
  | 'ready'
  /** Turned off by the operator. */
  | 'disabled'
  /** Signed out, so nothing can run on it. */
  | 'logged-out'
  /** A window is spent, or ccx was refused. `constraints` says which. */
  | 'blocked';

export interface AccountStatus {
  state: AccountState;
  /** Everything currently blocking, empty when ready. */
  constraints: Constraint[];
  /** What to name: the model when the model is blocked, else what lifts last. */
  label: string | null;
  /** When the account can be used again, ie. when the LAST constraint lifts. */
  until: number | null;
}

/** Everything blocking this account right now, judged on the usage as it stands. */
export function constraintsOn(
  a: DashboardAccount,
  model: string | null,
  now: number,
): Constraint[] {
  const out: Constraint[] = [];
  // ccx's own record of being refused. Kept separate from the numbers because
  // it is different evidence: this one was measured by being told no.
  if (a.cappedUntil && a.cappedUntil > now) out.push({ label: 'capped', until: a.cappedUntil });

  const spent = (used: number | null | undefined, resetsAt: number | null | undefined): boolean =>
    (effectiveUtilization(used, resetsAt, now) ?? 0) >= 1;

  const u = a.usage;
  if (u) {
    // Account-wide windows stop everything, whatever model you are on.
    if (spent(u.fiveHour, u.fiveHourReset)) out.push({ label: '5h', until: u.fiveHourReset });
    if (spent(u.sevenDay, u.sevenDayReset)) out.push({ label: 'week', until: u.sevenDayReset });
    // The model being asked about. The account may still serve others, so this
    // is named rather than reported as the account being out entirely.
    //
    // Matched through normalizeModel, not by lowercasing: the API calls a
    // window `Fable` while a session names the same model
    // `claude-fable-5[1m]`, and comparing those as text says they are
    // different. A spent model would then read as ready, which is the exact
    // failure this whole status rule exists to prevent.
    const key = model ? normalizeModel(model) : null;
    const found = key
      ? (u.models ?? []).find((m) => normalizeModel(m.name) === key)
      : undefined;
    if (found && spent(found.utilization, found.resetsAt)) {
      out.push({ label: found.name.toLowerCase(), until: found.resetsAt });
    }
  }
  return out;
}

/** The whole answer: usable or not, what is stopping it, and until when. */
export function accountStatus(
  a: DashboardAccount,
  model: string | null,
  now: number,
): AccountStatus {
  if (!a.enabled) return { state: 'disabled', constraints: [], label: null, until: null };
  if (!a.loggedIn) return { state: 'logged-out', constraints: [], label: null, until: null };

  const constraints = constraintsOn(a, model, now);
  if (constraints.length === 0) {
    return { state: 'ready', constraints, label: null, until: null };
  }

  // The wait runs until the LAST of them lifts, because until then the account
  // still cannot be used. Taking the earliest would promise a return that is
  // not coming; an unknown reset time sorts last for the same reason.
  const latest = constraints.reduce((a2, b) =>
    (b.until ?? Number.POSITIVE_INFINITY) > (a2.until ?? Number.POSITIVE_INFINITY) ? b : a2,
  );
  // Name the MODEL whenever the model is one of the things blocking, even if
  // something else lifts later. That is the question being asked: the column
  // says Fable is at 100%, and what matters is when Fable can be used again.
  const modelKey = model ? normalizeModel(model) : null;
  const named = constraints.find((c) => modelKey && normalizeModel(c.label) === modelKey) ?? latest;
  return {
    state: 'blocked',
    constraints,
    label: named.label,
    until: latest.until && latest.until > now ? latest.until : null,
  };
}
