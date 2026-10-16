import { bindingUtilization, type UsageLike } from '../usage/headroom.js';
import { fits } from './decide.js';

/**
 * Where the auto-switch watcher moves to.
 *
 * The same eligibility as every other move in ccx (enabled, signed in, not
 * down as refused), then the watcher's own bar: under the limit and
 * meaningfully roomier than the account being left. Among the accounts that
 * clear it, the order is whatever ccx is set to pick by, so the watcher goes
 * where a hand-made `ccx rotate` would have gone.
 */

/** An account as the watcher weighs it. */
export interface TargetCandidate {
  name: string;
  priority: number;
  enabled: boolean;
  loggedIn: boolean;
  /** ccx's ledger has a refused turn on record for it, and the limit has not lifted. */
  capped: boolean;
  usage: UsageLike | null | undefined;
}

export interface PickInput {
  /** The account being left. */
  current: string;
  candidates: readonly TargetCandidate[];
  /** Its tightest window, 0..1; 1 when nothing could be read. */
  currentUsed: number;
  /** The same without per-model weeks. */
  currentWide: number;
  /** Accounts to leave out until a time: a move there failed, or a fresh read found it full. */
  skipUntil: Readonly<Record<string, number>>;
  /** Every profile of the login in use. Moving between them gains no room. */
  sameLogin: readonly string[];
  /** A target must be under this, 0..1. */
  limit: number;
  /** And have this much more room than the account being left. */
  hysteresis: number;
  /**
   * May it settle for an account that only fits with one model's own week left
   * out? Only when the account in use cannot run at all, for any model.
   */
  otherModels: boolean;
  /** ccx's pick order, applied to the accounts that fit. */
  order: (a: TargetCandidate, b: TargetCandidate) => number;
  /** Count only this model's own week beside the account-wide windows; every model's when absent. */
  model?: string;
  now: number;
}

export type TargetPick =
  /** `other-models`: it only fits with one model's own week left out. */
  | { name: string; how: 'room' | 'other-models'; used: number }
  /** Nothing fits; `until` is when the soonest spent account opens again, when known. */
  | { name: null; until: number | null };

/** The tightest account-wide window still in force, per-model weeks left out. */
export function wideUtilization(usage: UsageLike | null | undefined, now: number): number | null {
  return usage ? bindingUtilization({ ...usage, models: [] }, undefined, now) : null;
}

export function pickTarget(input: PickInput): TargetPick {
  const { now, limit, hysteresis } = input;
  const eligible = input.candidates.filter(
    (a) =>
      a.name !== input.current &&
      !input.sameLogin.includes(a.name) &&
      a.enabled &&
      a.loggedIn &&
      !a.capped &&
      !((input.skipUntil[a.name] ?? 0) > now),
  );

  const choose = (
    read: (usage: UsageLike | null | undefined) => number | null,
    base: number,
    how: 'room' | 'other-models',
  ): TargetPick | null => {
    const first = eligible.filter((a) => fits(read(a.usage), base, limit, hysteresis)).sort(input.order)[0];
    return first ? { name: first.name, how, used: read(first.usage) ?? 0 } : null;
  };

  const byEveryWindow = choose((usage) => bindingUtilization(usage, input.model, now), input.currentUsed, 'room');
  if (byEveryWindow) return byEveryWindow;

  // Nothing runs on the account in use, for any model, and the accounts with
  // room are held back only by one model's own week. Those still run the other
  // models, which beats a machine where nothing runs. Only then: while the
  // account in use still serves, moving every session onto one where a model
  // is gone trades a working machine for refused turns, and a session refused
  // there moves back, to be moved again.
  if (input.otherModels) {
    const byWideWindows = choose((usage) => wideUtilization(usage, now), input.currentWide, 'other-models');
    if (byWideWindows) return byWideWindows;
  }

  return { name: null, until: soonestBack(input.candidates, limit, now) };
}

/**
 * When the soonest spent account can run again: an account is back once the
 * last of its spent windows has reset, and the soonest such account is the one
 * worth waiting for.
 */
function soonestBack(candidates: readonly TargetCandidate[], limit: number, now: number): number | null {
  const back: number[] = [];
  for (const a of candidates) {
    if (!a.enabled || !a.loggedIn || !a.usage) continue;
    const { fiveHour, sevenDay, fiveHourReset, sevenDayReset } = a.usage;
    const resets = [
      typeof fiveHour === 'number' && fiveHour >= limit ? fiveHourReset : null,
      typeof sevenDay === 'number' && sevenDay >= limit ? sevenDayReset : null,
    ].filter((at): at is number => typeof at === 'number' && at > now);
    if (resets.length > 0) back.push(Math.max(...resets));
  }
  return back.length > 0 ? Math.min(...back) : null;
}
