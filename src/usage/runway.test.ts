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
    expect(standingOf(entry, NOW, 'claude-fable-5[1m]').runway).toBeCloseTo(0.3);
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
    // 10 windows of budget, 50 hours (10 windows of time) to use them in.
    const s = standingOf(account({ sevenDay: 0, sevenDayReset: NOW + 50 * HOUR }), NOW);
    expect(s.urgency).toBe(1);
  });

  it('is low when the reset is far off', () => {
    // 5 windows of budget, 150 hours (30 windows of time).
    const s = standingOf(account({ sevenDay: 0.5, sevenDayReset: NOW + 150 * HOUR }), NOW);
    expect(s.urgency).toBeCloseTo(5 / 30);
  });

  it('is nothing when the week was never measured', () => {
    expect(standingOf(account({ sevenDay: null }), NOW).urgency).toBe(0);
  });
});

describe('pick order', () => {
  it('puts longer runway first, and urgency only breaks ties within a tenth of a window', () => {
    const longRunway = standingOf(account({ sevenDay: 0.5, sevenDayReset: NOW + 160 * HOUR }), NOW);
    const shorterButUrgent = standingOf(
      account({ fiveHour: 0.3, sevenDay: 0.9, sevenDayReset: NOW + 6 * HOUR }),
      NOW,
    );
    expect(longRunway.runway).toBe(1);
    expect(shorterButUrgent.runway).toBeCloseTo(0.7);
    expect(shorterButUrgent.urgency).toBeGreaterThan(longRunway.urgency);
    expect(pickScore(longRunway)).toBeGreaterThan(pickScore(shorterButUrgent));

    const sameRunwayExpiringSoon = standingOf(account({ sevenDay: 0.8, sevenDayReset: NOW + 10 * HOUR }), NOW);
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

describe('learning what a 5-hour window costs the week', () => {
  const reading = (fiveHour: number, sevenDay: number, over: Record<string, unknown> = {}) =>
    account({ fiveHour, sevenDay, ...over });

  it('learns from two readings in the same windows', () => {
    expect(learnWindowCost(reading(0.1, 0.4), reading(0.3, 0.43))).toBeCloseTo(0.15);
  });

  it('keeps a running average rather than jumping to the newest pair', () => {
    expect(learnWindowCost(reading(0.1, 0.4, { windowCost: 0.1 }), reading(0.3, 0.44))).toBeCloseTo(0.1 * 0.7 + 0.2 * 0.3);
  });

  it('learns nothing across a reset, or from too little use to measure', () => {
    const known = { windowCost: 0.12 };
    expect(learnWindowCost(reading(0.8, 0.4, known), reading(0.1, 0.42, { fiveHourReset: NOW + 8 * HOUR }))).toBe(0.12);
    expect(learnWindowCost(reading(0.1, 0.4, known), reading(0.12, 0.4))).toBe(0.12);
    expect(learnWindowCost(undefined, reading(0.3, 0.4))).toBeNull();
  });
});
