import { describe, it, expect } from 'vitest';
import { DEFAULT_WINDOW_COST, learnWindowCost, pickScore, standingOf } from './runway.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const HOUR = 60 * 60 * 1000;

const account = (over: Record<string, unknown> = {}) => ({
  fiveHour: 0,
  sevenDay: 0,
  fiveHourReset: NOW + 3 * HOUR,
  sevenDayReset: NOW + 100 * HOUR,
  ...over,
});

describe('runway: how much of a 5-hour window an account can still do', () => {
  it('is almost nothing when the 5-hour window is nearly spent, whatever the week says', () => {
    const s = standingOf(account({ fiveHour: 0.9, sevenDay: 0.1 }), NOW);
    expect(s.runway).toBeCloseTo(0.1);
    expect(s.binding).toBe('5-hour');
    expect(s.worthMoving).toBe(false);
  });

  it('is almost nothing when the week is nearly spent, however fresh the 5-hour window', () => {
    const s = standingOf(account({ fiveHour: 0, sevenDay: 0.99 }), NOW);
    expect(s.runway).toBeCloseTo(0.01 / DEFAULT_WINDOW_COST);
    expect(s.binding).toBe('weekly');
    expect(s.worthMoving).toBe(false);
  });

  it('weighs weekly room in 5-hour windows, so a quarter of a week beats 30% of a 5-hour window', () => {
    // Comparing the percentages directly picked the first one: 30% left beat
    // 25% left. A quarter of a week is several full 5-hour windows.
    const thinFiveHour = standingOf(account({ fiveHour: 0.7, sevenDay: 0.2 }), NOW);
    const quarterWeek = standingOf(account({ fiveHour: 0, sevenDay: 0.75 }), NOW);
    expect(thinFiveHour.runway).toBeCloseTo(0.3);
    expect(quarterWeek.runway).toBe(1);
    expect(pickScore(quarterWeek)).toBeGreaterThan(pickScore(thinFiveHour));
  });

  it("uses the account's learned window cost", () => {
    // A plan where one full 5-hour window costs 40% of the week.
    const s = standingOf(account({ sevenDay: 0.8, windowCost: 0.4 }), NOW);
    expect(s.runway).toBeCloseTo(0.5);
    expect(s.binding).toBe('weekly');
  });

  it("counts the model's own weekly window only for that model", () => {
    const entry = account({ models: [{ name: 'Fable', utilization: 0.97, resetsAt: NOW + 50 * HOUR }] });
    expect(standingOf(entry, NOW, 'claude-fable-5[1m]').runway).toBeCloseTo(0.03 / DEFAULT_WINDOW_COST);
    expect(standingOf(entry, NOW, 'claude-fable-5[1m]').binding).toBe('model');
    expect(standingOf(entry, NOW, 'opus[1m]').runway).toBe(1);
    expect(standingOf(entry, NOW).runway).toBe(1);
  });

  it('treats a window past its reset as fresh', () => {
    const s = standingOf(account({ fiveHour: 0.95, fiveHourReset: NOW - HOUR }), NOW);
    expect(s.runway).toBe(1);
  });

  it('treats an account with no readings as open, with nothing known to expire', () => {
    const s = standingOf(undefined, NOW);
    expect(s).toMatchObject({ runway: 1, binding: 'none', urgency: 0, weeklyWindowsLeft: null, worthMoving: true });
  });
});

describe('urgency: leftover weekly budget at risk of expiring unused', () => {
  it('is full when more is left than could be used before the reset', () => {
    // About 6.7 windows of budget, 30 hours (6 windows of time) to use them in.
    const s = standingOf(account({ sevenDay: 0, sevenDayReset: NOW + 30 * HOUR }), NOW);
    expect(s.urgency).toBe(1);
  });

  it('is low when the reset is far off', () => {
    // About 3.3 windows of budget, 150 hours (30 windows of time).
    const s = standingOf(account({ sevenDay: 0.5, sevenDayReset: NOW + 150 * HOUR }), NOW);
    expect(s.urgency).toBeCloseTo(0.5 / DEFAULT_WINDOW_COST / 30);
  });

  it('is nothing when the week was never measured', () => {
    expect(standingOf(account({ sevenDay: null }), NOW).urgency).toBe(0);
  });
});

describe('pick order', () => {
  it('puts longer runway first, and urgency only breaks ties within a tenth of a window', () => {
    // With no week held back (null), so this is runway and urgency alone.
    const longRunway = standingOf(account({ sevenDay: 0.5, sevenDayReset: NOW + 160 * HOUR }), NOW, null, null);
    const shorterButUrgent = standingOf(
      account({ fiveHour: 0.3, sevenDay: 0.9, sevenDayReset: NOW + 6 * HOUR }),
      NOW,
      null,
      null,
    );
    expect(longRunway.runway).toBe(1);
    expect(shorterButUrgent.runway).toBeCloseTo(0.1 / DEFAULT_WINDOW_COST);
    expect(shorterButUrgent.urgency).toBeGreaterThan(longRunway.urgency);
    expect(pickScore(longRunway)).toBeGreaterThan(pickScore(shorterButUrgent));

    const sameRunwayExpiringSoon = standingOf(
      account({ sevenDay: 0.8, sevenDayReset: NOW + 10 * HOUR }),
      NOW,
      null,
      null,
    );
    expect(sameRunwayExpiringSoon.runway).toBe(1);
    expect(pickScore(sameRunwayExpiringSoon)).toBeGreaterThan(pickScore(longRunway));
  });

  it('puts every account worth moving to before any that is not', () => {
    const barely = standingOf(account({ fiveHour: 0.7 }), NOW); // 0.3: worth it
    const sliver = standingOf(account({ fiveHour: 0.8, sevenDay: 0.98, sevenDayReset: NOW + HOUR }), NOW); // 0.2
    expect(barely.worthMoving).toBe(true);
    expect(sliver.worthMoving).toBe(false);
    expect(pickScore(barely)).toBeGreaterThan(pickScore(sliver));
  });
});


describe('a spent account against one with a sliver of room', () => {
  it('ranks the sliver first, however urgent the spent one week is', () => {
    // The urgency bonus used to count with no runway at all, so a spent 5-hour
    // window with half a week left outranked an account with a little room.
    const spent = standingOf(account({ fiveHour: 1, sevenDay: 0.5, sevenDayReset: NOW + 48 * HOUR }), NOW);
    const sliver = standingOf(account({ fiveHour: 0.96, sevenDay: 0.1, sevenDayReset: NOW + 144 * HOUR }), NOW);
    expect(spent.runway).toBe(0);
    // No urgency bonus at all without runway to use it in.
    expect(pickScore(spent)).toBe(pickScore({ ...spent, urgency: 0 }));
    expect(pickScore(sliver)).toBeGreaterThan(pickScore(spent));
  });
});

describe('holding back a nearly spent week', () => {
  // The accounts as they stood when a week 89% used was picked second.
  const phx1 = account({ fiveHour: 0, sevenDay: 0.89, sevenDayReset: NOW + 24 * HOUR });
  const alvi = account({ fiveHour: 0.13, sevenDay: 0.03, windowCost: 0.145, sevenDayReset: NOW + 166 * HOUR });
  const ad911 = account({ fiveHour: 0.45, sevenDay: 0.68, windowCost: 0.214, sevenDayReset: NOW + 106 * HOUR });

  it('puts it after every healthy account that can run half a window, however fresh its 5-hour window', () => {
    const held = standingOf(phx1, NOW);
    expect(held.heldBack).toBe(true);
    expect(held.weekLeft).toBeCloseTo(0.11);
    expect(standingOf(alvi, NOW).heldBack).toBe(false);
    expect(pickScore(standingOf(alvi, NOW))).toBeGreaterThan(pickScore(held));
    // Even an account about half a window from its 5-hour wall.
    expect(pickScore(standingOf(ad911, NOW))).toBeGreaterThan(pickScore(held));
  });

  it('stays behind healthy accounts even when its window cost is underestimated', () => {
    // At the old default cost of 0.1 its 11% read as a full window, and with
    // nothing held back (100) that outscored an account 13% into its 5-hour.
    const optimistic = account({ ...phx1, windowCost: 0.1 });
    expect(pickScore(standingOf(optimistic, NOW, null, 100))).toBeGreaterThan(
      pickScore(standingOf(alvi, NOW, null, 100)),
    );
    expect(pickScore(standingOf(optimistic, NOW))).toBeLessThan(pickScore(standingOf(alvi, NOW)));
  });

  it('goes ahead of a healthy account with under half a window, when it can run longer', () => {
    // One point of week apart: holding the full window back for the 40% one
    // would mean another move within two hours.
    const fullWindowHeld = standingOf(account({ fiveHour: 0, sevenDay: 0.8 }), NOW);
    const shortHealthy = standingOf(account({ fiveHour: 0.6, sevenDay: 0.79 }), NOW);
    expect(fullWindowHeld.heldBack).toBe(true);
    expect(shortHealthy.heldBack).toBe(false);
    expect(pickScore(fullWindowHeld)).toBeGreaterThan(pickScore(shortHealthy));
    // A healthy account with half a window or more still goes first.
    const halfHealthy = standingOf(account({ fiveHour: 0.5, sevenDay: 0.79 }), NOW);
    expect(pickScore(halfHealthy)).toBeGreaterThan(pickScore(fullWindowHeld));
  });

  it('still beats a healthy week whose 5-hour window has minutes left', () => {
    const minutesLeft = standingOf(account({ fiveHour: 0.9, sevenDay: 0.1 }), NOW);
    expect(minutesLeft.worthMoving).toBe(false);
    expect(pickScore(standingOf(phx1, NOW))).toBeGreaterThan(pickScore(minutesLeft));
  });

  it("counts the model's own week, only for that model", () => {
    const entry = account({ sevenDay: 0.3, models: [{ name: 'Fable', utilization: 0.85, resetsAt: NOW + 50 * HOUR }] });
    expect(standingOf(entry, NOW, 'claude-fable-5').heldBack).toBe(true);
    expect(standingOf(entry, NOW, 'claude-fable-5').weekLeft).toBeCloseTo(0.15);
    expect(standingOf(entry, NOW, 'opus').heldBack).toBe(false);
    expect(standingOf(entry, NOW, 'opus').weekLeft).toBeCloseTo(0.7);
  });

  it('holds back at the whole percent the screen shows, and not below it', () => {
    expect(standingOf(account({ sevenDay: 0.8 }), NOW).heldBack).toBe(true);
    expect(standingOf(account({ sevenDay: 0.79 }), NOW).heldBack).toBe(false);
    expect(standingOf(account({ sevenDay: 0.79 }), NOW, null, 75).heldBack).toBe(true);
  });

  it('holds nothing back when off, for an order that does not, or for a week never measured', () => {
    expect(standingOf(phx1, NOW, null, 100).heldBack).toBe(false);
    // Off means off, a week read as 100% included.
    expect(standingOf(account({ sevenDay: 1 }), NOW, null, 100).heldBack).toBe(false);
    expect(standingOf(phx1, NOW, null, null).heldBack).toBe(false);
    expect(standingOf(account({ sevenDay: null }), NOW).heldBack).toBe(false);
    expect(standingOf(undefined, NOW).weekLeft).toBeNull();
  });
});

describe('learning what a 5-hour window costs the week', () => {
  const reading = (fiveHour: number, sevenDay: number, over: Record<string, unknown> = {}) =>
    account({ fiveHour, sevenDay, ...over });
  const anchored = (fiveHour: number, sevenDay: number, over: Record<string, unknown> = {}) => ({
    ...reading(fiveHour, sevenDay, over),
    costAnchor: { fiveHour, sevenDay, fiveHourReset: NOW + 3 * HOUR, sevenDayReset: NOW + 100 * HOUR },
  });

  it('starts measuring from the first reading', () => {
    expect(learnWindowCost(undefined, reading(0.1, 0.4))).toEqual({
      windowCost: null,
      costAnchor: { fiveHour: 0.1, sevenDay: 0.4, fiveHourReset: NOW + 3 * HOUR, sevenDayReset: NOW + 100 * HOUR },
    });
  });

  it('keeps measuring from the same anchor until the 5-hour window has moved a fifth', () => {
    const before = anchored(0.1, 0.4);
    const out = learnWindowCost(before, reading(0.2, 0.41));
    expect(out.windowCost).toBeNull();
    expect(out.costAnchor).toEqual(before.costAnchor);
  });

  it('takes a sample across a fifth of a window, folded into the default', () => {
    // 3 points of the week over 22 points of a 5-hour window.
    const out = learnWindowCost(anchored(0.1, 0.4), reading(0.32, 0.43));
    expect(out.windowCost).toBeCloseTo(DEFAULT_WINDOW_COST * 0.7 + (0.03 / 0.22) * 0.3);
    expect(out.costAnchor?.fiveHour).toBe(0.32);
  });

  it('never lets one still week make the week invisible', () => {
    // The week did not move at all over a fifth of a window: the sample says
    // "nearly free". Taken whole, 97% of a week used read as a full window.
    const out = learnWindowCost(anchored(0.1, 0.4), reading(0.35, 0.4));
    expect(out.windowCost).toBeCloseTo(DEFAULT_WINDOW_COST * 0.7 + 0.01 * 0.3);
    const week = standingOf(account({ sevenDay: 0.97, windowCost: out.windowCost }), NOW);
    expect(week.runway).toBeLessThan(0.5);
  });

  it('starts over across a reset of either window', () => {
    const known = { windowCost: 0.12 };
    const fiveHourReset = learnWindowCost(anchored(0.8, 0.4, known), reading(0.1, 0.42, { fiveHourReset: NOW + 8 * HOUR }));
    expect(fiveHourReset.windowCost).toBe(0.12);
    expect(fiveHourReset.costAnchor?.fiveHour).toBe(0.1);
    const weekReset = learnWindowCost(anchored(0.1, 0.9, known), reading(0.4, 0.05, { sevenDayReset: NOW + 200 * HOUR }));
    expect(weekReset.windowCost).toBe(0.12);
  });
});
