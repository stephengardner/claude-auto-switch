/**
 * Keep the usage snapshot alive while any session is running.
 *
 * The snapshot feeds rotation targeting (which account still has room on THIS
 * model) and the dashboard, and refreshing it is also what renews idle
 * profiles' logins before they rot. It used to be refreshed only by the
 * proactive-rotation loop, which is a FEATURE, off by default. With proactive
 * off and no dashboard open, nothing refreshed anything: the snapshot found
 * tonight was ten hours stale while seven sessions ran, so rotation was
 * choosing targets from the morning's numbers and idle profiles were quietly
 * dying of old age.
 *
 * Watching data is not a feature to opt into; it is the floor. This runner is
 * mounted for every interactive session, and stays cheap two ways:
 *
 * - fresh-enough: when the snapshot is younger than half the interval, there
 *   is nothing worth asking. This is what keeps N concurrent sessions from
 *   multiplying the probes: whoever refreshed last covered everyone.
 * - one at a time: a try-lock, never waited on. A busy lock means another
 *   session is refreshing right now, which is the freshest answer available.
 */

export type RefreshOutcome = 'refreshed' | 'fresh-enough' | 'busy' | 'error';

export interface UsageRefresherDeps {
  /** Run one full refresh (probe every account, write the snapshot). */
  refresh: () => Promise<unknown>;
  /** How old the stored snapshot is, in ms; Infinity when there is none. */
  snapshotAgeMs: () => number;
  /** Try to become the one refresher; never waits. */
  tryLock: () => { held: boolean; release: () => void };
  /** Told what each tick decided, with the evidence. */
  onOutcome?: (outcome: RefreshOutcome, detail: { ageMs: number; error?: string }) => void;
  now?: () => number;
}

/** One decision + refresh cycle. Exported so the policy is testable alone. */
export async function refresherTick(
  deps: UsageRefresherDeps,
  intervalMs: number,
): Promise<RefreshOutcome> {
  const ageMs = deps.snapshotAgeMs();
  if (ageMs < intervalMs / 2) {
    deps.onOutcome?.('fresh-enough', { ageMs });
    return 'fresh-enough';
  }
  const lock = deps.tryLock();
  if (!lock.held) {
    deps.onOutcome?.('busy', { ageMs });
    return 'busy';
  }
  try {
    await deps.refresh();
    deps.onOutcome?.('refreshed', { ageMs });
    return 'refreshed';
  } catch (err) {
    // A failed refresh must never take the session down with it; the stale
    // snapshot stays, and the log says why it is stale.
    deps.onOutcome?.('error', { ageMs, error: (err as Error).message });
    return 'error';
  } finally {
    lock.release();
  }
}

export interface UsageRefresher {
  stop(): void;
}

/**
 * Run {@link refresherTick} for the lifetime of a session. The first tick runs
 * right away, because the most common reason to need one is a snapshot nobody
 * has touched for hours. The timer is unref'd so it can never keep the process
 * alive on its own.
 */
export function startUsageRefresher(deps: UsageRefresherDeps, intervalMs: number): UsageRefresher {
  let running = false;
  const tick = (): void => {
    if (running) return; // never overlap a slow refresh with the next one
    running = true;
    void refresherTick(deps, intervalMs).finally(() => {
      running = false;
    });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
  };
}
