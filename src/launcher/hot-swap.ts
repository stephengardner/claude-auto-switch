import { outOfAccountsMessage } from './out-of-accounts.js';
export interface HotSwapAccount {
  name: string;
  dir: string;
}

export interface SessionOutcome {
  kind: 'ok' | 'capped' | 'no-conversation' | 'switch' | 'needs-login';
  exitCode: number;
  reason?: string;
  resetAt?: number;
  /**
   * How long the session ran. Used to refuse a cap for a session that ended too
   * fast to have hit one: those are startup failures, and believing them once
   * capped every account the operator had.
   */
  ranMs?: number;
  /** For kind 'switch': the account the operator asked to switch to, in place. */
  switchTo?: string;
}

export interface HotSwapDeps {
  /** Next healthy account, excluding the given capped names; null when none remain. */
  nextAccount: (excluding: Set<string>) => HotSwapAccount | null;
  /** Resolve a specific account by name (for an operator-requested switch); null if unusable. */
  resolveAccount: (name: string) => HotSwapAccount | null;
  /** The account the session is actually on now (it may have moved via a seamless swap). */
  currentAccount?: () => string;
  /**
   * Run one claude session (the real impl runs it inside a PTY). `isContinue`
   * resumes the same conversation (--continue) after a swap.
   */
  runSession: (
    account: HotSwapAccount,
    isContinue: boolean,
    options?: { ignoreLimits?: boolean },
  ) => Promise<SessionOutcome>;
  /** Persist a cap so other sessions avoid the account too. */
  markCapped: (account: string, reason: string, resetAt: number | undefined) => void;
  /** ccx status messages (never stdout, and never into Claude's screen). */
  notify: (message: string) => void;
  /**
   * Somewhere to run when every account has hit a limit, used when those limits
   * are about ONE MODEL rather than the accounts themselves. Refusing to start
   * in that situation is wrong: the session works fine on another model, and
   * declining to launch reads as being signed out instead of being told to
   * switch models.
   */
  lastResort?: () => { account: HotSwapAccount; message: string } | null;
  /**
   * Accounts already known to have a rejected login, so they are skipped without
   * being launched first.
   *
   * Seeded into the same set that a rejection discovered at runtime goes into,
   * rather than filtered out inside `nextAccount`. That is what keeps the ending
   * honest: the closing message reads this set to decide between "wait for a
   * reset" and "sign in again", so an account that is skipped silently would
   * leave the operator waiting for a reset that cannot fix a sign-in.
   */
  knownDeadAccounts?: () => string[];
  /**
   * Accounts with no stored login at all.
   *
   * They are already invisible to selection, so this exists purely so the
   * ending can tell the truth about them. Without it they are silently absent
   * and the operator is told to wait for a reset, which never produces a login.
   * Kept apart from the refused ones because "sign in again" is wrong for an
   * account that has never been signed in.
   */
  accountsNeverSignedIn?: () => string[];
  /**
   * Accounts that were ALREADY out of room when this run started, from the
   * ledger.
   *
   * The running set only collects accounts that hit a limit during this
   * session, so without this the ending names none of the accounts that were
   * capped before it began. That is how an operator with two capped accounts
   * and two dead logins got told only about the sign-ins, leaving the actual
   * reason there was nothing to run on unmentioned.
   *
   * Used for the ENDING ONLY, never for selection: `nextAccount` is the
   * authority on what can run, and excluding accounts here as well would let a
   * stale ledger entry veto an account that has since reset.
   */
  knownCappedAccounts?: () => string[];
  /**
   * The last word, said when there is nothing left to run on and ccx is about
   * to exit.
   *
   * Deliberately NOT `notify`. That channel draws nothing on purpose, because
   * Claude owns the screen while a session is running and writing there would
   * scribble over it. Nothing owns the screen once the loop has run out of
   * accounts, and sending the ending down the silent channel is what left the
   * operator staring at a blank prompt, running the same command three times,
   * with the explanation written only to a log file.
   */
  report: (message: string) => void;
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
  /**
   * Accounts whose stored login is dead: it cannot be renewed and the server
   * rejects it. Skipped like a capped one, but NOT recorded as capped, because
   * nothing is exhausted and the fix is a sign-in rather than a wait.
   */
  const needsLogin = new Set<string>(deps.knownDeadAccounts?.() ?? []);
  let first = true;
  // When the operator picks an account mid-session, we relaunch on THAT account
  // next (instead of the policy pick), resuming the same conversation.
  let forced: HotSwapAccount | null = null;
  let triedLastResort = false;

  for (;;) {
    const account: HotSwapAccount | null =
      forced ?? deps.nextAccount(new Set([...capped, ...needsLogin]));
    forced = null;
    if (!account) {
      // Out of accounts to rotate to. If what is exhausted is one model rather
      // than the accounts, run anyway and let Claude say so: it can still work
      // on another model. Watching for limits is off for that run, otherwise it
      // would be ended immediately by the very limit we already know about.
      const fallback = triedLastResort ? null : deps.lastResort?.();
      if (fallback) {
        triedLastResort = true;
        deps.notify(fallback.message);
        const outcome = await deps.runSession(fallback.account, !first, { ignoreLimits: true });
        // The last resort is chosen for having ROOM, which says nothing about
        // whether its stored login still works. A dead one here must take the
        // same path as anywhere else, or it returns the dead session's exit code
        // and the operator is told nothing about why.
        if (outcome.kind === 'needs-login') {
          needsLogin.add(fallback.account.name);
          deps.notify(`"${fallback.account.name}" needs signing in again; trying another account...`);
          continue;
        }
        return outcome.exitCode;
      }
      deps.report(
        outOfAccountsMessage({
          capped: [...capped, ...(deps.knownCappedAccounts?.() ?? [])],
          refused: [...needsLogin],
          neverSignedIn: deps.accountsNeverSignedIn?.() ?? [],
        }),
      );
      return 1;
    }

    const outcome = await deps.runSession(account, !first);

    if (outcome.kind === 'needs-login') {
      // Its stored login is finished, so starting here would hand Claude a dead
      // token and produce "Login expired" with nothing to act on. Try the next
      // account instead. `first` is deliberately not advanced: nothing ran, so
      // the next attempt is still the first real session and must not resume.
      needsLogin.add(account.name);
      deps.notify(`"${account.name}" needs signing in again; trying another account...`);
      continue;
    }
    first = false;

    if (outcome.kind === 'capped') {
      // The session may have moved via a seamless swap; attribute to the real one.
      const capName = deps.currentAccount?.() || account.name;
      capped.add(capName);
      deps.markCapped(capName, outcome.reason ?? 'usage cap', outcome.resetAt);
      deps.notify(`"${capName}" hit its limit; continuing on another account...`);
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
