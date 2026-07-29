import { decideProactiveSwitch, type ProactiveCandidate, type UsageLike } from './headroom.js';

/**
 * Move off an account BEFORE it runs out, rather than waiting to hit the wall.
 *
 * Usage is cheap to read (a plain GET, no tokens), so a run can watch its own
 * headroom and hand the session to a roomier account while everything is still
 * working. The switch itself goes through the normal request path, which means
 * a live session moves in place and keeps its conversation.
 */

export interface ProactiveDeps {
  /** Accounts that could be switched to, with their current eligibility. */
  candidates: () => ProactiveCandidate[];
  /** The account in use right now, or null when there is none. */
  current: () => string | null;
  /** Refresh + return usage per account (TTL-cached upstream). */
  usage: () => Promise<Map<string, UsageLike>>;
  /** Ask for the switch (writes a switch request / sets the active account). */
  requestSwitch: (account: string, reason: string) => void;
  /** Percent at which an account is considered "nearly out" (0 disables). */
  thresholdPercent: number;
  /** Require this many points more headroom on the target (anti-flap). */
  hysteresisPercent?: number;
  /** Do not switch again within this window. */
  cooldownMs?: number;
  /** Restrict the decision to one model's window (e.g. "Fable"). */
  model?: string;
  now?: () => number;
  onError?: (error: Error) => void;
}

export interface TickResult {
  /** What happened, for logs and the `ccx auto` exit code. */
  outcome: 'switched' | 'no-switch' | 'cooldown' | 'disabled' | 'error';
  account?: string;
  reason: string;
}

/**
 * One decision cycle. Safe to call at any time: it never throws, and anything
 * it cannot establish (usage unknown, no current account) results in no switch.
 */
export async function proactiveTick(
  deps: ProactiveDeps,
  state: { lastSwitchAt?: number } = {},
): Promise<TickResult> {
  const now = deps.now ?? (() => Date.now());
  if (!deps.thresholdPercent || deps.thresholdPercent <= 0) {
    return { outcome: 'disabled', reason: 'proactive rotation is off' };
  }
  const current = deps.current();
  if (!current) return { outcome: 'no-switch', reason: 'no current account' };

  const cooldown = deps.cooldownMs ?? 5 * 60_000;
  if (state.lastSwitchAt !== undefined && now() - state.lastSwitchAt < cooldown) {
    return { outcome: 'cooldown', reason: 'switched recently' };
  }

  let usage: Map<string, UsageLike>;
  try {
    usage = await deps.usage();
  } catch (err) {
    deps.onError?.(err as Error);
    return { outcome: 'error', reason: (err as Error).message };
  }

  const decision = decideProactiveSwitch({
    current,
    candidates: deps.candidates(),
    usage,
    thresholdPercent: deps.thresholdPercent,
    ...(deps.hysteresisPercent !== undefined ? { hysteresisPercent: deps.hysteresisPercent } : {}),
    ...(deps.model ? { model: deps.model } : {}),
  });

  if (!decision.switchTo) return { outcome: 'no-switch', reason: decision.reason };

  try {
    deps.requestSwitch(decision.switchTo, decision.reason);
  } catch (err) {
    deps.onError?.(err as Error);
    return { outcome: 'error', reason: (err as Error).message };
  }
  state.lastSwitchAt = now();
  return { outcome: 'switched', account: decision.switchTo, reason: decision.reason };
}

export interface ProactiveRunner {
  stop(): void;
}

/**
 * Run {@link proactiveTick} on an interval for the lifetime of a session. The
 * timer is unref'd so it can never keep the process alive on its own.
 */
export function startProactiveRotation(deps: ProactiveDeps, intervalMs: number): ProactiveRunner {
  const state: { lastSwitchAt?: number } = {};
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // never overlap a slow tick with the next one
    running = true;
    void proactiveTick(deps, state).finally(() => {
      running = false;
    });
  }, intervalMs);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
  };
}
