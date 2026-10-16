/**
 * When the auto-switch watcher moves off the account in use, and when it
 * holds still.
 *
 * Everything here is pure: the watcher reads usage on its own clock, hands the
 * readings in, and acts on what comes back, so every rule can be driven with
 * made-up numbers and no login.
 *
 * The rules lean one way on purpose. A move made too early costs a session
 * one in-place switch. A move made too late leaves every session on the
 * machine stopped at a limit until somebody notices. So an account that can
 * still run is left only on evidence (a reading at the threshold, or two
 * readings heading there fast), while one that cannot run at all is left on
 * the second sign of it.
 */

export const MINUTE = 60_000;

/** A reading older than this no longer says where the account stands now. */
export const FRESH_MS = 90_000;
/** One move on a refused or unreadable login per half hour, at most. */
const RISKY_GAP_MS = 30 * MINUTE;
/** A fast burn only counts once the account is at least half used. */
const BURN_FLOOR = 0.5;
/** How far ahead a burn is projected. */
const BURN_HORIZON_MS = 10 * MINUTE;
/** With no fresh reading, a last one this close under the threshold counts as near it. */
const BLIND_MARGIN = 0.05;

/** One reading of the account in use, taken by the watcher itself. */
export interface Reading {
  /** The tightest window still in force, 0..1, every model's own week included. */
  used: number;
  /** The same without the per-model weeks: what stops every model at once. */
  wide: number;
  /**
   * Usage credits carry this account past its plan windows. A full window
   * then does not stop it, so it is never "spent": it is an account near its
   * limit, which a pick holds and which is left only for somewhere roomier.
   */
  carried?: boolean;
  at: number;
}

/**
 * Why a move is made.
 *
 * `early`, `burn` and `blind-high` leave an account that still works, so a
 * person's pick and the early-moves switch hold them back. `spent`, `dead` and
 * `blind` leave one that cannot run: nothing holds those but a full pause.
 */
export type MoveKind = 'early' | 'burn' | 'blind-high' | 'spent' | 'dead' | 'blind' | 'forced';

export type WaitReason = 'fine' | 'quiet' | 'confirming' | 'settling' | 'cooldown' | 'held';

export type Decision =
  | { act: true; kind: MoveKind; why: string }
  | { act: false; cat: WaitReason; why: string };

export interface DecideInput {
  now: number;
  /** When the account in use became the one in use. */
  since: number;
  /** The newest own reading, while it is fresh. */
  fresh: Reading | null;
  /** The reading before it. */
  prev: Reading | null;
  /** The newest own reading of the last half hour, fresh or not. */
  lastKnown: Reading | null;
  /** Since when ccx's ledger has this account down as refused, or null. */
  cappedSince: number | null;
  /** No read has answered for three minutes, and what failed was a refusal or a rate limit, not the network. */
  readsFailing: boolean;
  /** Reads refused (401 or 403 on a token that has not expired) since the last one that answered. */
  refusals: { count: number; first: number; last: number } | null;
  /** The last move made off a refused or unreadable login. */
  lastRiskyAt: number | null;
  /** Where an early move starts, 0..1. */
  threshold: number;
}

const pct = (fraction: number): string => `${Math.round(fraction * 100)}%`;

/** Whether a kind of move leaves an account that could still have run. */
export function isEarly(kind: MoveKind): boolean {
  return kind === 'early' || kind === 'burn' || kind === 'blind-high';
}

/** One decision. Never throws, and anything it cannot establish is a reason to stay. */
export function decide(input: DecideInput): Decision {
  const { now, fresh, prev, lastKnown, cappedSince, refusals, threshold } = input;
  const held = now - input.since;
  const risky = input.lastRiskyAt !== null && now - input.lastRiskyAt < RISKY_GAP_MS;

  if (fresh && fresh.used >= 1 && !fresh.carried) {
    // Spent. One reading can be a window about to reset or a number written
    // mid-change, so a second one has to agree: far enough apart to be a
    // second look, close enough to be about the same moment. A turn ccx has
    // already recorded as refused on this account is that second opinion too.
    const gap = prev ? fresh.at - prev.at : 0;
    const twice = prev !== null && prev.used >= 1 && gap >= 25_000 && gap <= 5 * MINUTE;
    const refused = cappedSince !== null && now - cappedSince >= 30_000;
    if (!twice && !refused) {
      return { act: false, cat: 'confirming', why: `spent (${pct(fresh.used)}), confirming on the next reading` };
    }
    if (held < MINUTE) {
      return { act: false, cat: 'settling', why: 'spent, but the account changed under a minute ago; letting that land' };
    }
    return { act: true, kind: 'spent', why: `${pct(fresh.used)} used` };
  }

  if (fresh && fresh.used >= threshold) {
    if (held < 2 * MINUTE) {
      return { act: false, cat: 'cooldown', why: `at ${pct(fresh.used)}, but on this account under two minutes` };
    }
    return { act: true, kind: 'early', why: `${pct(fresh.used)} used` };
  }

  if (fresh && prev && fresh.used >= BURN_FLOOR && fresh.at > prev.at) {
    // A fast burn crosses the threshold and the limit between two readings.
    // Project the last two forward rather than wait to read the wall.
    const rate = (fresh.used - prev.used) / (fresh.at - prev.at);
    if (rate > 0 && (1 - fresh.used) / rate < BURN_HORIZON_MS) {
      if (held < 2 * MINUTE) {
        return { act: false, cat: 'cooldown', why: 'burning fast, but on this account under two minutes' };
      }
      return { act: true, kind: 'burn', why: `${pct(fresh.used)} used and heading for its limit within ten minutes` };
    }
  }

  if (!fresh && lastKnown && lastKnown.used >= threshold - BLIND_MARGIN && now - lastKnown.at <= 30 * MINUTE) {
    // A read that failed is not a quiet account. With the last answer already
    // high, assume it has gone on climbing.
    if (held < 2 * MINUTE) {
      return {
        act: false,
        cat: 'cooldown',
        why: 'no fresh reading and the last one was high, but on this account under two minutes',
      };
    }
    return { act: true, kind: 'blind-high', why: `no fresh reading; the last one was ${pct(lastKnown.used)}` };
  }

  if (!fresh && refusals && refusals.count >= 2 && refusals.last - refusals.first >= 25_000) {
    // Refused twice, 25 seconds apart. A login caught mid-renewal answers
    // again within seconds, so this one is gone.
    if (held < MINUTE) {
      return {
        act: false,
        cat: 'settling',
        why: 'login refused, but the account changed under a minute ago; letting that land',
      };
    }
    if (risky) {
      return { act: false, cat: 'held', why: 'login refused, but a move off a refused login was made under half an hour ago' };
    }
    return { act: true, kind: 'dead', why: 'its login is refused' };
  }

  if (!fresh && input.readsFailing && cappedSince !== null && now - cappedSince >= 5 * MINUTE && held >= 5 * MINUTE) {
    // Nothing to read at all, and ccx has had a refused turn on record for
    // five minutes with nobody moving.
    if (risky) {
      return { act: false, cat: 'held', why: 'usage unreadable, but a move off an unreadable login was made under half an hour ago' };
    }
    return { act: true, kind: 'blind', why: 'usage unreadable and a turn was refused five minutes ago' };
  }

  if (fresh) return { act: false, cat: 'fine', why: `fine at ${pct(fresh.used)}` };
  return { act: false, cat: 'quiet', why: 'nothing near the limit' };
}

/**
 * How long to leave between reads of the account in use.
 *
 * Once a minute at any level. The usage endpoint has a small budget of its
 * own: reading it every thirty seconds gets a login rate limited, and a rate
 * limited read is worse than a slightly older one. Thirty seconds only while
 * confirming a spent or refused login, which lasts one or two reads.
 */
export function readEvery(confirming: boolean): number {
  return confirming ? 30_000 : MINUTE;
}

/**
 * Does a target fit? Under the limit, and with `hysteresis` more room than the
 * account being left, so two similar accounts never hand a session back and
 * forth. Usage nobody could read never fits: it could be a seat billed by use.
 */
export function fits(used: number | null, currentUsed: number, limit: number, hysteresis: number): boolean {
  // The epsilon keeps a target exactly `hysteresis` roomier from losing to a
  // sum that lands a hair above it.
  return typeof used === 'number' && used < limit && 1 - used >= 1 - currentUsed + hysteresis - 1e-9;
}

/** The account somebody chose by hand, and when. */
export interface HandPick {
  account: string;
  at: number;
}

/** A pick is written just after the account is made active; this covers a file time rounded to the second. */
const PICK_SLACK_MS = 5_000;

/**
 * The pick that stands, if one does: for the account in use, and made when it
 * became the one in use or since.
 *
 * The second half matters. A pick is not cleared when a session moves on by
 * itself, so one made last week for this account would otherwise come back to
 * life the next time the automation happened to return to it.
 */
export function standingPick(pick: HandPick | null, current: string, since: number): HandPick | null {
  return pick !== null && pick.account === current && pick.at >= since - PICK_SLACK_MS ? pick : null;
}

/**
 * A person's own pick beats the automation: while the account they chose is
 * still the one in use, no early move leaves it. Once it cannot run at all the
 * pick is moot, since staying would stop every session, and a move they ask
 * for themselves is theirs as well.
 */
export function handPickHolds(pick: HandPick | null, current: string, kind: MoveKind): boolean {
  return pick !== null && pick.account === current && isEarly(kind);
}

/** The last pass that found no account with room. */
export interface NoRoom {
  at: number;
  /** Whether that pass used the looser bar a spent account gets. */
  loose?: boolean;
}

/**
 * "Nothing has room" holds for three minutes, so the watcher does not ask
 * every account again each pass. An early pass's answer never holds back a
 * spent one, though: the spent pass takes a looser bar and may find room the
 * early pass turned down.
 */
export function noneHolds(none: NoRoom | null, now: number, blocked: boolean): boolean {
  return none !== null && now - none.at < 3 * MINUTE && (none.loose === true || !blocked);
}

/**
 * Why staying is right when no target fits and the account in use is still
 * under its limit account-wide: `model-only` when only one model's own week is
 * spent (every other model still runs here), `tight` when it is burning fast
 * and nothing is roomy enough. Null is the other case: it really is out.
 */
export function stayKind(fresh: Reading | null, threshold: number): 'model-only' | 'tight' | null {
  if (!fresh || fresh.wide >= threshold) return null;
  return fresh.used >= threshold ? 'model-only' : 'tight';
}

/** A target a fresh read found too full, and which kind of pass found it. */
export interface FullMark {
  until: number;
  loose: boolean;
}

/**
 * Targets a fresh read found near their limit stay out for five minutes. A
 * spent pass skips only the ones a spent pass found full: an early pass holds
 * targets to a stricter bar, and leaves out accounts the looser one can take.
 */
export function fullSkip(full: Record<string, FullMark>, now: number, blocked: boolean): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, mark] of Object.entries(full)) {
    if (mark.until > now && (!blocked || mark.loose)) out[name] = mark.until;
  }
  return out;
}
