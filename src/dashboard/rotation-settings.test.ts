import { describe, it, expect } from 'vitest';
import {
  modelPreferenceWords,
  nextModelPreference,
  nextOrder,
  canRunChain,
  modelUsageFor,
  numberPicks,
  orderWords,
  pickReason,
  rankAccounts,
  reorder,
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
    // 20% of a week left. At the default cost that is two full windows; at a
    // learned 0.4 it is half of one.
    'costly-week': { fiveHour: 0, sevenDay: 0.8, windowCost: 0.4, ...open },
  };

  it("uses each account's learned window cost, as rotation does", () => {
    const ranked = rankAccounts(accounts, (name) => usage[name], 'smart', 'opus', NOW);
    expect(ranked.map((a) => a.name)).toEqual(['thin', 'costly-week']);
  });

  it('ranks by priority under your order, and by remaining room under most room', () => {
    expect(rankAccounts(accounts, (name) => usage[name], 'priority', 'opus', NOW).map((a) => a.name)).toEqual([
      'thin',
      'costly-week',
    ]);
    // most-room reads the tighter percentage: 70% left against 20% left.
    expect(rankAccounts(accounts, (name) => usage[name], 'most-room', 'opus', NOW).map((a) => a.name)).toEqual([
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
