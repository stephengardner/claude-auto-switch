/**
 * What ended this session, when a limit did, and which answer wins.
 *
 * There are several writers: a text match trusted directly, a probe that
 * confirms one, a held match confirmed after the child exits, and the unproven
 * hold raised when a session keeps hitting a wall nobody can explain. They do
 * not carry equal weight:
 *
 *   A CONFIRMED limit reports a real window, measured by asking the account.
 *   Acting on it holds the pairing until that window reopens.
 *
 *   An unproven HOLD reports no window at all, because none was measured. It
 *   exists to get a stuck session moving, and lasts a couple of minutes.
 *
 * So a confirmation must always replace a hold, and a hold must never replace a
 * confirmation. That rule used to live nowhere: every writer spelled it out for
 * itself with `!capped`, and five separate reviews of one pull request each
 * found a different place where it was spelled wrong. The failure was always
 * the same shape, a confirmed cap discarded in favour of the two-minute hold,
 * which returns the account to rotation long before its real window reopens,
 * straight back into the same wall.
 *
 * One place to get it right, and the writers no longer have to know the rule.
 */

export interface CapRecord {
  reason?: string;
  resetAt?: number;
}

export interface CapOutcome {
  /**
   * A limit the account itself confirmed. Always wins, including over a hold
   * that was already raised while this was being asked.
   */
  confirm(record: CapRecord): void;
  /**
   * A limit nothing could prove, raised to get a stuck session moving. Taken
   * only when nothing is recorded yet, so it can never displace a confirmation.
   */
  hold(record: CapRecord): void;
  /** What to report, or null when no limit ended this session. */
  get(): CapRecord | null;
  /** Has anything been recorded? */
  isSet(): boolean;
  /** Was what is recorded actually confirmed, rather than held? */
  isConfirmed(): boolean;
}

export function createCapOutcome(): CapOutcome {
  let record: CapRecord | null = null;
  let confirmed = false;

  return {
    confirm(next: CapRecord): void {
      record = next;
      confirmed = true;
    },
    hold(next: CapRecord): void {
      if (record) return;
      record = next;
    },
    get(): CapRecord | null {
      return record;
    },
    isSet(): boolean {
      return record !== null;
    },
    isConfirmed(): boolean {
      return confirmed;
    },
  };
}
