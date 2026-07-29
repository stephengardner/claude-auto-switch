/**
 * Usage policy: how much room an account has left, and when to move off it
 * BEFORE it hits the wall.
 *
 * A subscription has several windows running at once (a 5-hour session window, a
 * weekly all-models window, and a weekly window per model such as Fable). The
 * one that runs out first is the "binding" window, so that is what decides both
 * how healthy an account is and when to rotate. Judging by the 5-hour number
 * alone is exactly how an account looks fine while its weekly model window is
 * what actually stops you.
 */

export interface UsageLike {
  /** 0..1 utilization, or null when unknown. */
  fiveHour: number | null;
  sevenDay: number | null;
  models?: Array<{ name: string; utilization: number }> | null;
}

/** The worst (binding) utilization across every window, or null when unknown. */
export function bindingUtilization(usage: UsageLike | undefined | null, model?: string): number | null {
  if (!usage) return null;
  const values: number[] = [];
  if (typeof usage.fiveHour === 'number') values.push(usage.fiveHour);
  if (typeof usage.sevenDay === 'number') values.push(usage.sevenDay);
  for (const m of usage.models ?? []) {
    // When a model is named, only that model's window is relevant alongside the
    // account-wide ones; otherwise every model window counts.
    if (model && m.name.toLowerCase() !== model.toLowerCase()) continue;
    if (typeof m.utilization === 'number') values.push(m.utilization);
  }
  return values.length > 0 ? Math.max(...values) : null;
}

/** Remaining room (0..1) on the binding window, or null when unknown. */
export function headroom(usage: UsageLike | undefined | null, model?: string): number | null {
  const used = bindingUtilization(usage, model);
  return used === null ? null : Math.max(0, 1 - used);
}

export interface ProactiveCandidate {
  name: string;
  enabled: boolean;
  loggedIn: boolean;
  capped?: boolean;
}

export interface ProactiveInput {
  /** The account in use right now. */
  current: string;
  candidates: ProactiveCandidate[];
  /** Account name -> its usage snapshot. */
  usage: Map<string, UsageLike>;
  /** Move off an account once its binding window reaches this percent (0..100). */
  thresholdPercent: number;
  /**
   * Only move when the target has at least this many percentage points more
   * room than the current account, so two similar accounts cannot ping-pong.
   */
  hysteresisPercent?: number;
  /** Restrict the decision to one model's window (e.g. "Fable"). */
  model?: string;
}

export interface ProactiveDecision {
  switchTo: string | null;
  reason: string;
}

/**
 * Decide whether to move off the current account before it runs out. Fail-safe
 * by construction: unknown usage never triggers a switch, and a target is only
 * chosen when it is both under the threshold and meaningfully roomier.
 */
export function decideProactiveSwitch(input: ProactiveInput): ProactiveDecision {
  const threshold = input.thresholdPercent / 100;
  const hysteresis = (input.hysteresisPercent ?? 10) / 100;

  const currentUsed = bindingUtilization(input.usage.get(input.current), input.model);
  if (currentUsed === null) {
    return { switchTo: null, reason: 'current account usage unknown' };
  }
  if (currentUsed < threshold) {
    return { switchTo: null, reason: `current account at ${pct(currentUsed)} (under threshold)` };
  }

  const currentRoom = 1 - currentUsed;
  const eligible = input.candidates.filter(
    (c) => c.name !== input.current && c.enabled && c.loggedIn && !c.capped,
  );

  let best: { name: string; room: number } | null = null;
  for (const c of eligible) {
    const room = headroom(input.usage.get(c.name), input.model);
    if (room === null) continue; // never gamble on an unknown account
    if (1 - room >= threshold) continue; // already at/над the threshold itself
    if (room < currentRoom + hysteresis) continue; // not meaningfully better
    if (!best || room > best.room) best = { name: c.name, room };
  }

  if (!best) {
    return { switchTo: null, reason: `current account at ${pct(currentUsed)}, no roomier account available` };
  }
  return {
    switchTo: best.name,
    reason: `current account at ${pct(currentUsed)}, "${best.name}" has ${pct(1 - best.room)} used`,
  };
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
