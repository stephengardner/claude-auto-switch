export interface HotSwapAccount {
  name: string;
  dir: string;
}

export interface SessionOutcome {
  kind: 'ok' | 'capped' | 'no-conversation';
  exitCode: number;
  reason?: string;
  resetAt?: number;
}

export interface HotSwapDeps {
  /** Next healthy account, excluding the given capped names; null when none remain. */
  nextAccount: (excluding: Set<string>) => HotSwapAccount | null;
  /**
   * Run one claude session (the real impl runs it inside a PTY). `isContinue`
   * resumes the same conversation (--continue) after a swap.
   */
  runSession: (account: HotSwapAccount, isContinue: boolean) => Promise<SessionOutcome>;
  /** Persist a cap so other sessions avoid the account too. */
  markCapped: (account: string, reason: string, resetAt: number | undefined) => void;
  /** ccx status messages (routed to stderr, never stdout). */
  notify: (message: string) => void;
}

/**
 * Drive an interactive session with transparent hot-swap: run on a healthy
 * account, and each time it caps, swap to the next healthy account and resume
 * the SAME conversation (--continue), in place. Returns the exit code of the
 * session that ended normally, or 1 if every account is capped.
 *
 * This is the pure orchestration; the PTY I/O and account credential wiring are
 * injected via `runSession`, so the swap logic is fully testable.
 */
export async function runHotSwapSession(deps: HotSwapDeps): Promise<number> {
  const capped = new Set<string>();
  let first = true;

  for (;;) {
    const account = deps.nextAccount(capped);
    if (!account) {
      deps.notify('every account is capped; try again after a reset');
      return 1;
    }

    const outcome = await deps.runSession(account, !first);
    first = false;

    if (outcome.kind === 'capped') {
      capped.add(account.name);
      deps.markCapped(account.name, outcome.reason ?? 'usage cap', outcome.resetAt);
      deps.notify(`"${account.name}" hit its limit; continuing on another account...`);
      continue;
    }
    return outcome.exitCode;
  }
}
