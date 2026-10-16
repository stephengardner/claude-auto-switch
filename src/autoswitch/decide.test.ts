import { describe, it, expect } from 'vitest';
import {
  decide,
  fits,
  fullSkip,
  handPickHolds,
  MINUTE,
  noneHolds,
  readEvery,
  standingPick,
  stayKind,
  type DecideInput,
  type Reading,
} from './decide.js';

const now = Date.parse('2030-01-15T12:00:00Z');
const reading = (used: number, ago = 0, wide = used): Reading => ({ used, wide, at: now - ago });
const judge = (over: Partial<DecideInput>) =>
  decide({
    now,
    since: now - 10 * MINUTE,
    fresh: null,
    prev: null,
    lastKnown: null,
    cappedSince: null,
    readsFailing: false,
    refusals: null,
    lastRiskyAt: null,
    threshold: 0.85,
    ...over,
  });

describe('deciding whether to move off the account in use', () => {
  it('stays while there is room', () => {
    expect(judge({ fresh: reading(0.5) })).toMatchObject({ act: false, cat: 'fine' });
    expect(judge({ fresh: reading(0.84) })).toMatchObject({ act: false, cat: 'fine' });
  });

  it('moves early at the threshold, once the account has been in use two minutes', () => {
    expect(judge({ fresh: reading(0.86) })).toMatchObject({ act: true, kind: 'early' });
    expect(judge({ fresh: reading(0.96) })).toMatchObject({ act: true, kind: 'early' });
    expect(judge({ fresh: reading(0.96), since: now - MINUTE })).toMatchObject({ act: false, cat: 'cooldown' });
  });

  it('follows the threshold it is given', () => {
    expect(judge({ fresh: reading(0.72), threshold: 0.7 })).toMatchObject({ act: true, kind: 'early' });
    expect(judge({ fresh: reading(0.72), threshold: 0.9 })).toMatchObject({ act: false, cat: 'fine' });
  });

  it('moves on a fast burn that would reach the limit within ten minutes', () => {
    expect(judge({ fresh: reading(0.75), prev: reading(0.6, MINUTE) })).toMatchObject({ act: true, kind: 'burn' });
    expect(judge({ fresh: reading(0.75), prev: reading(0.6, MINUTE), since: now - MINUTE })).toMatchObject({
      act: false,
      cat: 'cooldown',
    });
    expect(judge({ fresh: reading(0.61), prev: reading(0.6, MINUTE) })).toMatchObject({ act: false, cat: 'fine' });
  });

  it('never calls a burn below half used, however steep', () => {
    expect(judge({ fresh: reading(0.4), prev: reading(0.1, MINUTE) })).toMatchObject({ act: false, cat: 'fine' });
  });

  it('treats a high last reading as near the limit when no read answers', () => {
    expect(judge({ lastKnown: reading(0.88, 3 * MINUTE), readsFailing: true })).toMatchObject({
      act: true,
      kind: 'blind-high',
    });
    expect(judge({ lastKnown: reading(0.88, 30_000), since: now - MINUTE })).toMatchObject({
      act: false,
      cat: 'cooldown',
    });
    expect(judge({ lastKnown: reading(0.6, 3 * MINUTE) })).toMatchObject({ act: false, cat: 'quiet' });
    expect(judge({ lastKnown: reading(0.9, 40 * MINUTE) })).toMatchObject({ act: false, cat: 'quiet' });
  });

  it('confirms a spent account on a second reading before it moves', () => {
    expect(judge({ fresh: reading(1) })).toMatchObject({ act: false, cat: 'confirming' });
    expect(judge({ fresh: reading(1), prev: reading(1, 40_000) })).toMatchObject({ act: true, kind: 'spent' });
    // Too close together is one reading twice; too far apart is two separate moments.
    expect(judge({ fresh: reading(1), prev: reading(1, 10_000) })).toMatchObject({ act: false, cat: 'confirming' });
    expect(judge({ fresh: reading(1), prev: reading(1, 10 * MINUTE) })).toMatchObject({
      act: false,
      cat: 'confirming',
    });
  });

  it("takes ccx's own record of a refused turn as the second opinion", () => {
    expect(judge({ fresh: reading(1), cappedSince: now - MINUTE })).toMatchObject({ act: true, kind: 'spent' });
  });

  it('lets a switch that just landed settle before judging the new account spent', () => {
    expect(judge({ fresh: reading(1), prev: reading(1, 40_000), since: now - 30_000 })).toMatchObject({
      act: false,
      cat: 'settling',
    });
    // Two minutes on a spent account is long enough: no five-minute wait.
    expect(judge({ fresh: reading(1), prev: reading(1, 40_000), since: now - 2 * MINUTE })).toMatchObject({
      act: true,
      kind: 'spent',
    });
  });

  it('moves off a login refused on two reads, not one', () => {
    const twice = { count: 2, first: now - 30_000, last: now };
    expect(judge({ refusals: twice })).toMatchObject({ act: true, kind: 'dead' });
    expect(judge({ refusals: { count: 1, first: now, last: now } })).toMatchObject({ act: false });
    expect(judge({ refusals: twice, since: now - 30_000 })).toMatchObject({ act: false, cat: 'settling' });
  });

  it('moves blind only when reads fail and ccx has recorded a refusal for five minutes', () => {
    expect(judge({ readsFailing: true, cappedSince: now - 6 * MINUTE })).toMatchObject({ act: true, kind: 'blind' });
    expect(judge({ readsFailing: true, cappedSince: now - 3 * MINUTE })).toMatchObject({ act: false });
    expect(judge({ cappedSince: now - 6 * MINUTE })).toMatchObject({ act: false, cat: 'quiet' });
  });

  it('makes at most one move on a refused or unreadable login per half hour', () => {
    const twice = { count: 2, first: now - 30_000, last: now };
    expect(judge({ refusals: twice, lastRiskyAt: now - 10 * MINUTE })).toMatchObject({ act: false, cat: 'held' });
    expect(judge({ readsFailing: true, cappedSince: now - 6 * MINUTE, lastRiskyAt: now - 10 * MINUTE })).toMatchObject({
      act: false,
      cat: 'held',
    });
    expect(judge({ refusals: twice, lastRiskyAt: now - 31 * MINUTE })).toMatchObject({ act: true, kind: 'dead' });
  });

  it('does not call an account spent while usage credits carry it past its plan windows', () => {
    const carried = { ...reading(1), carried: true };
    // It still serves: this is an account near its limit, which a pick holds.
    expect(judge({ fresh: carried, prev: { ...reading(1, 40_000), carried: true } })).toMatchObject({
      act: true,
      kind: 'early',
    });
    expect(judge({ fresh: carried, since: now - MINUTE })).toMatchObject({ act: false, cat: 'cooldown' });
  });

  it('trusts a reading that answered over every other sign', () => {
    expect(judge({ fresh: reading(0.4), cappedSince: now - 6 * MINUTE })).toMatchObject({ act: false, cat: 'fine' });
    expect(judge({ fresh: reading(0.5), refusals: { count: 3, first: now - 90_000, last: now - 60_000 } })).toMatchObject({
      act: false,
      cat: 'fine',
    });
  });
});

describe('how often the account in use is read', () => {
  it('is once a minute at any level, and twice only while confirming', () => {
    expect(readEvery(false)).toBe(MINUTE);
    expect(readEvery(true)).toBe(30_000);
  });
});

describe('whether a target fits', () => {
  it('needs to be under the limit and meaningfully roomier', () => {
    expect(fits(0.6, 0.9, 0.85, 0.1)).toBe(true);
    expect(fits(0.84, 0.92, 0.85, 0.1)).toBe(false);
    expect(fits(0.86, 1, 0.85, 0.1)).toBe(false);
  });

  it('takes a looser bar when the account in use is spent', () => {
    expect(fits(0.9, 1, 0.95, 0.05)).toBe(true);
    expect(fits(0.95, 1, 0.95, 0.05)).toBe(false);
  });

  it('never fits an account nobody could read', () => {
    expect(fits(null, 1, 0.85, 0.1)).toBe(false);
  });

  it('counts exactly the hysteresis as enough, whatever floating point says', () => {
    expect(fits(0.8, 0.9, 0.85, 0.1)).toBe(true);
  });
});

describe("a person's own pick", () => {
  const pick = { account: 'work', at: now - MINUTE };

  it('holds against every early move', () => {
    expect(handPickHolds(pick, 'work', 'early')).toBe(true);
    expect(handPickHolds(pick, 'work', 'burn')).toBe(true);
    expect(handPickHolds(pick, 'work', 'blind-high')).toBe(true);
  });

  it('does not hold once the picked account cannot run at all', () => {
    expect(handPickHolds(pick, 'work', 'spent')).toBe(false);
    expect(handPickHolds(pick, 'work', 'dead')).toBe(false);
    expect(handPickHolds(pick, 'work', 'blind')).toBe(false);
  });

  it('never holds a move the person asked for', () => {
    expect(handPickHolds(pick, 'work', 'forced')).toBe(false);
  });

  it('is over once another account is in use', () => {
    expect(handPickHolds(pick, 'personal', 'early')).toBe(false);
    expect(handPickHolds(null, 'work', 'early')).toBe(false);
  });

  it('stands when it is what made the account the one in use, or was made since', () => {
    const since = now - 10 * MINUTE;
    expect(standingPick({ account: 'work', at: since + 20 }, 'work', since)).toEqual({ account: 'work', at: since + 20 });
    expect(standingPick(pick, 'work', since)).toEqual(pick);
    // A file's time can be rounded down to the second the pick was made in.
    expect(standingPick({ account: 'work', at: since - 900 }, 'work', since)).not.toBeNull();
  });

  it('does not come back to life when the automation returns to an account picked long ago', () => {
    const lastWeek = { account: 'work', at: now - 7 * 24 * 60 * MINUTE };
    expect(standingPick(lastWeek, 'work', now - 10 * MINUTE)).toBeNull();
    expect(standingPick(pick, 'personal', now - 10 * MINUTE)).toBeNull();
    expect(standingPick(null, 'work', now)).toBeNull();
  });
});

describe('waiting after nothing had room', () => {
  it('waits three minutes before looking again', () => {
    expect(noneHolds({ at: now - MINUTE, loose: false }, now, false)).toBe(true);
    expect(noneHolds({ at: now - 4 * MINUTE, loose: true }, now, true)).toBe(false);
    expect(noneHolds(null, now, false)).toBe(false);
  });

  it('never lets an early pass hold back a spent one, which takes the looser bar', () => {
    expect(noneHolds({ at: now - MINUTE, loose: false }, now, true)).toBe(false);
    expect(noneHolds({ at: now - MINUTE, loose: true }, now, true)).toBe(true);
    // The looser bar already said no, so the stricter one need not ask.
    expect(noneHolds({ at: now - MINUTE, loose: true }, now, false)).toBe(true);
  });
});

describe('why the watcher stays when no target fits', () => {
  it('names a spent model week apart from a tight account', () => {
    expect(stayKind(reading(0.9, 0, 0.6), 0.85)).toBe('model-only');
    expect(stayKind(reading(0.8, 0, 0.8), 0.85)).toBe('tight');
  });

  it('is the no-room case when the account itself is at its limit, or unread', () => {
    expect(stayKind(reading(0.9, 0, 0.9), 0.85)).toBeNull();
    expect(stayKind(null, 0.85)).toBeNull();
  });
});

describe('targets a fresh read found full', () => {
  const full = {
    early: { until: now + 3 * MINUTE, loose: false },
    spent: { until: now + 3 * MINUTE, loose: true },
    gone: { until: now - 1000, loose: true },
  };

  it('stay out for an early pass, whichever pass found them', () => {
    expect(fullSkip(full, now, false)).toEqual({ early: now + 3 * MINUTE, spent: now + 3 * MINUTE });
  });

  it('are retried by a spent pass unless a spent pass turned them down', () => {
    expect(Object.keys(fullSkip(full, now, true))).toEqual(['spent']);
  });
});
