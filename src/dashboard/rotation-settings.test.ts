import { describe, it, expect } from 'vitest';
import {
  modelPreferenceWords,
  nextModelPreference,
  nextOrder,
  orderWords,
  pickReason,
  reorder,
} from './rotation-settings.js';
import { standingOf } from '../usage/runway.js';

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

  it('starts the cycle over from a preference it does not offer', () => {
    expect(nextModelPreference(['sonnet', 'opus'])).toEqual(['opus', 'fable']);
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
