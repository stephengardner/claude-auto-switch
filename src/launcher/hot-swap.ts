export interface HotSwapAccount {
  name: string;
  dir: string;
}

export interface SessionOutcome {
  kind: 'ok' | 'capped' | 'no-conversation' | 'switch';
  exitCode: number;
  reason?: string;
  resetAt?: number;
  /** For kind 'switch': the account the operator asked to switch to, in place. */
  switchTo?: string;
}

export interface HotSwapDeps {
  /** Next healthy account, excluding the given capped names; null when none remain. */
  nextAccount: (excluding: Set<string>) => HotSwapAccount | null;
  /** Resolve a specific account by name (for an operator-requested switch); null if unusable. */
  resolveAccount: (name: string) => HotSwapAccount | null;
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
  // When the operator picks an account mid-session, we relaunch on THAT account
  // next (instead of the policy pick), resuming the same conversation.
  let forced: HotSwapAccount | null = null;

  for (;;) {
    const account: HotSwapAccount | null = forced ?? deps.nextAccount(capped);
    forced = null;
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

    if (outcome.kind === 'switch' && outcome.switchTo) {
      const target = deps.resolveAccount(outcome.switchTo);
      // A manual pick overrides a prior cap-avoidance for that account.
      capped.delete(outcome.switchTo);
      // Relaunch the SAME conversation (--continue): on the requested account if
      // it resolves, otherwise fall back to the current one so ending the child
      // never drops the session.
      forced = target ?? account;
      if (target) deps.notify(`switching to "${target.name}"...`);
      continue;
    }

    return outcome.exitCode;
  }
}
