/**
 * When repeated refusals stop being credible.
 *
 * ccx never turns rendered text into a cap on its own: the API decides. That
 * guard is right, and it is why a conversation that merely TALKS about rate
 * limits does not end a session. But it has one failure mode, and it is the
 * worst kind: when the API cannot account for a limit that is genuinely
 * happening, ccx refuses, and refuses, and refuses, and the operator sits there
 * blocked while the log fills with reasons not to act.
 *
 * That happened. Every account reported only a Fable window, a session was
 * believed to be on Opus, and every real limit was dismissed as "a limit on a
 * model you are not using" for as long as the operator kept trying.
 *
 * So refusals are counted. A REPLAY looks like a burst: a resumed conversation
 * re-renders its old cap message within seconds of starting, several times, all
 * at once. A real limit looks like persistence: the operator tries again, and
 * again, minutes apart. Spread over time is what separates them, and it is why
 * a count alone is not the test.
 */

export interface RefusalWatchOptions {
  /** How many refusals of one kind before the pattern outweighs the check. */
  after?: number;
  /**
   * How far apart the first and last must be. A resumed conversation replays
   * its old cap text in one burst, so a cluster proves nothing; minutes of
   * recurrence is somebody actually hitting a wall.
   */
  spreadMs?: number;
}

export interface RefusalWatch {
  /**
   * Record a refusal ccx could not verify.
   *
   * Returns true when the refusals have earned more doubt than the check that
   * produced them, meaning: stop refusing and act. Resets itself when it says
   * so, so one pattern fires once rather than on every tick afterwards.
   */
  refused(reason: string, now: number): boolean;
  /** Something changed (a rotation, a model change). The pattern is stale. */
  reset(): void;
  /** How many refusals of the current reason are outstanding, for the log. */
  count(): number;
}

export function createRefusalWatch(options: RefusalWatchOptions = {}): RefusalWatch {
  const after = options.after ?? 3;
  // Two minutes, not five. The spread is here to exclude a REPLAY, and a
  // resumed conversation re-renders its old cap text within seconds of
  // starting, so two minutes is already a twentyfold margin over the thing it
  // guards against. Five minutes bought no extra certainty and cost the
  // operator three more minutes of sitting blocked, with a scheduled task
  // failing every ten.
  const spreadMs = options.spreadMs ?? 2 * 60_000;
  let reason: string | null = null;
  let times: number[] = [];

  return {
    refused(nextReason: string, now: number): boolean {
      // A different reason is a different story, so it starts its own count.
      // Otherwise unrelated refusals would add up to an escalation that no one
      // of them justified.
      if (nextReason !== reason) {
        reason = nextReason;
        times = [];
      }
      times.push(now);
      const first = times[0] as number;
      if (times.length < after || now - first < spreadMs) return false;
      reason = null;
      times = [];
      return true;
    },
    reset(): void {
      reason = null;
      times = [];
    },
    count(): number {
      return times.length;
    },
  };
}
