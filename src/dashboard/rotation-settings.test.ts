import { describe, it, expect } from 'vitest';
import {
  modelPreferenceWords,
  nextModelPreference,
  nextOrder,
  canRunChain,
  holdBackOf,
  modelUsageFor,
  numberPicks,
  orderWords,
  pickReason,
  rankAccounts,
  reorder,
  settingsWords,
} from './rotation-settings.js';
import { standingOf } from '../usage/runway.js';
import type { AccountModelUsage } from '../usage/model-preference.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const HOUR = 60 * 60 * 1000;

describe('model preference', () => {
  it('reads as words', () => {
    expect(modelPreferenceWords(['opus', 'fable'])).toBe('Opus, then Fable');
    expect(modelPreferenceWords(['claude-fable-5[1m]'])).toBe('Fable only');
  });

  it('cycles Opus first, Fable first, Opus only, Fable only, and round again', () => {
    expect(nextModelPreference(['opus', 'fable'])).toEqual(['fable', 'opus']);
    expect(nextModelPreference(['fable', 'opus'])).toEqual(['opus']);
    expect(nextModelPreference(['opus'])).toEqual(['fable']);
    expect(nextModelPreference(['fable'])).toEqual(['opus', 'fable']);
  });

  it('leaves a chain it does not offer alone, rather than replace it', () => {
    expect(nextModelPreference(['sonnet', 'opus'])).toBeNull();
  });

  it("keeps the user's own spelling of each model", () => {
    expect(nextModelPreference(['claude-opus-5[1m]', 'claude-fable-5[1m]'])).toEqual([
      'claude-fable-5[1m]',
      'claude-opus-5[1m]',
    ]);
    expect(nextModelPreference(['claude-fable-5[1m]', 'claude-opus-5[1m]'])).toEqual(['claude-opus-5[1m]']);
  });
});

describe('pick rule', () => {
  it('cycles smart, most room, your order', () => {
    expect(nextOrder('smart')).toBe('most-room');
    expect(nextOrder('most-room')).toBe('priority');
    expect(nextOrder('priority')).toBe('smart');
    expect(orderWords('priority')).toBe('your order');
  });

  it('says why an account is picked', () => {
    const fresh = standingOf({ fiveHour: 0, sevenDay: 0.5, sevenDayReset: NOW + 30 * HOUR }, NOW);
    expect(pickReason(fresh, NOW)).toBe('room for a full 5-hour window, its week resets in 1d 6h');
    const thin = standingOf({ fiveHour: 0.6, sevenDay: null }, NOW);
    expect(pickReason(thin, NOW)).toBe('room for 40% of a 5-hour window');
  });

  it('says a held-back pick is the fallback, not the choice', () => {
    const held = standingOf({ fiveHour: 0, sevenDay: 0.89, sevenDayReset: NOW + 24 * HOUR }, NOW);
    expect(pickReason(held, NOW)).toBe(
      'room for 73% of a 5-hour window, 11% of its week left (held back; nothing healthier has room)',
    );
  });

  it('puts the settings line in words, the hold-back only where it applies', () => {
    expect(settingsWords({ modelPreference: ['opus', 'fable'], accountOrder: 'smart', holdBackAtPercent: 80 })).toEqual({
      model: 'Opus, then Fable',
      order: 'longest run first',
      holdBack: 'weeks 80%+ used',
    });
    expect(settingsWords({ modelPreference: ['opus'], accountOrder: 'smart', holdBackAtPercent: 100 })).toEqual({
      model: 'Opus only',
      order: 'longest run first',
    });
    expect(settingsWords({ modelPreference: ['opus'], accountOrder: 'priority' }).holdBack).toBeUndefined();
  });
});

describe('ranking accounts the way rotation picks them', () => {
  const accounts = [
    { name: 'thin', priority: 0, enabled: true },
    { name: 'costly-week', priority: 1, enabled: true },
  ];
  type Entry = {
    fiveHour: number | null;
    sevenDay: number | null;
    fiveHourReset: number | null;
    sevenDayReset: number | null;
    windowCost?: number;
  };
  const open = { fiveHourReset: null, sevenDayReset: null };
  const usage: Record<string, Entry> = {
    thin: { fiveHour: 0.3, sevenDay: 0.1, ...open }, // 0.7 of a window
    // 30% of a week left, short of being held back. At the default cost that
    // is two full windows; at a learned 0.6 it is half of one.
    'costly-week': { fiveHour: 0, sevenDay: 0.7, windowCost: 0.6, ...open },
  };

  it("uses each account's learned window cost, as rotation does", () => {
    const ranked = rankAccounts(accounts, (name) => usage[name], { accountOrder: 'smart' }, 'opus', NOW);
    expect(ranked.map((a) => a.name)).toEqual(['thin', 'costly-week']);
    // The same week at the default cost: two windows, so it comes first.
    const unlearned: Record<string, Entry> = {
      thin: usage.thin!,
      'costly-week': { fiveHour: 0, sevenDay: 0.7, ...open },
    };
    expect(
      rankAccounts(accounts, (name) => unlearned[name], { accountOrder: 'smart' }, 'opus', NOW).map((a) => a.name),
    ).toEqual(['costly-week', 'thin']);
  });

  it('holds a nearly spent week back under the smart order, and only there', () => {
    const fresh: Record<string, Entry> = {
      thin: { fiveHour: 0.4, sevenDay: 0.1, ...open }, // 0.6 of a window
      // A fresh 5-hour window on a week 89% used.
      'costly-week': { fiveHour: 0, sevenDay: 0.89, ...open },
    };
    const ranked = (policy: Parameters<typeof rankAccounts>[2]) =>
      rankAccounts(accounts, (name) => fresh[name], policy, 'opus', NOW).map((a) => a.name);
    expect(ranked({ accountOrder: 'smart' })).toEqual(['thin', 'costly-week']);
    // Held back from 90% instead: its 11% is about three quarters of a
    // window, more than thin's 0.6, so it goes first.
    expect(ranked({ accountOrder: 'smart', holdBackAtPercent: 90 })).toEqual(['costly-week', 'thin']);
    expect(holdBackOf({ accountOrder: 'smart' })).toBe(80);
    expect(holdBackOf({ accountOrder: 'most-room', holdBackAtPercent: 70 })).toBeNull();
  });

  it('ranks by priority under your order, and by remaining room under most room', () => {
    expect(rankAccounts(accounts, (name) => usage[name], { accountOrder: 'priority' }, 'opus', NOW).map((a) => a.name)).toEqual([
      'thin',
      'costly-week',
    ]);
    // most-room reads the tighter percentage: 70% left against 30% left.
    expect(rankAccounts(accounts, (name) => usage[name], { accountOrder: 'most-room' }, 'opus', NOW).map((a) => a.name)).toEqual([
      'thin',
      'costly-week',
    ]);
  });
});

describe('moving an account in the priority order', () => {
  const accounts = [
    { name: 'a', priority: 0 },
    { name: 'b', priority: 1 },
    { name: 'c', priority: 2 },
  ];

  it('swaps it with its neighbour', () => {
    expect(reorder(accounts, 'c', -1)).toEqual([
      { name: 'c', priority: 1 },
      { name: 'b', priority: 2 },
    ]);
    expect(reorder(accounts, 'a', 1)).toEqual([
      { name: 'b', priority: 0 },
      { name: 'a', priority: 1 },
    ]);
  });

  it('does nothing off either end', () => {
    expect(reorder(accounts, 'a', -1)).toEqual([]);
    expect(reorder(accounts, 'c', 1)).toEqual([]);
    expect(reorder(accounts, 'nobody', 1)).toEqual([]);
  });

  it('renumbers ties so a move always moves', () => {
    const tied = [
      { name: 'a', priority: 0 },
      { name: 'b', priority: 0 },
      { name: 'c', priority: 0 },
    ];
    expect(reorder(tied, 'c', -1)).toEqual([
      { name: 'c', priority: 1 },
      { name: 'b', priority: 2 },
    ]);
  });
});

describe('numbering the picks', () => {
  const standing = () => standingOf(undefined, NOW);
  const candidates: AccountModelUsage[] = [
    { name: 'out', models: {}, accountWideOut: true },
    { name: 'chain-spent', models: { opus: 1, fable: 1 } },
    { name: 'opus-room', models: { opus: 0.4, fable: 1 } },
    { name: 'fresh', models: {} },
  ];

  it('numbers only accounts with room on some model in the chain, as the planner picks', () => {
    const picks = numberPicks(candidates, ['opus', 'fable'], true, standing);
    expect([...picks.entries()].map(([name, p]) => [name, p.rank])).toEqual([
      ['opus-room', 1],
      ['fresh', 2],
    ]);
  });

  it('numbers every candidate when models are switched off', () => {
    const picks = numberPicks(candidates, ['opus', 'fable'], false, standing);
    expect([...picks.keys()]).toEqual(['out', 'chain-spent', 'opus-room', 'fresh']);
  });

  it('marks a held-back pick with how much of its week is left', () => {
    const nearlySpent = () => standingOf({ fiveHour: 0, sevenDay: 0.89 }, NOW);
    const picks = numberPicks([{ name: 'fresh', models: {} }], ['opus'], true, nearlySpent);
    expect(picks.get('fresh')?.heldBack?.weekLeft).toBeCloseTo(0.11);
    expect(numberPicks([{ name: 'fresh', models: {} }], ['opus'], true, standing).get('fresh')?.heldBack).toBeUndefined();
  });
});

describe('what an account can run', () => {
  const NOW_ = Date.parse('2026-10-03T12:00:00Z');
  const entry = {
    fiveHour: 0.2,
    sevenDay: 0.3,
    fiveHourReset: NOW_ + HOUR,
    sevenDayReset: NOW_ + 50 * HOUR,
    models: [{ name: 'Fable', utilization: 0.3, resetsAt: NOW_ + 50 * HOUR }],
  };

  it("lays the ledger's model caps over usage, keyed the same way", () => {
    const usage = modelUsageFor('a', entry, [{ account: 'a', model: 'claude-fable-5[1m]' }], NOW_);
    expect(usage.models.fable).toBe(1);
    expect(canRunChain(usage, ['fable'])).toBe(false);
    expect(canRunChain(usage, ['fable', 'opus'])).toBe(true);
  });

  it('cannot run any of the chain when the account is out account-wide', () => {
    const out = modelUsageFor('a', { ...entry, sevenDay: 1 }, [], NOW_);
    expect(out.accountWideOut).toBe(true);
    expect(canRunChain(out, ['opus', 'fable'])).toBe(false);
  });
});
