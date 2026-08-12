import { describe, it, expect } from 'vitest';
import { normalizeModel, hasRoomFor, type AccountModelUsage } from './model-preference.js';

function account(name: string, models: Record<string, number | null>, wide = false): AccountModelUsage {
  return { name, models, ...(wide ? { accountWideOut: true } : {}) };
}

describe('normalizeModel', () => {
  it('treats the many spellings of one model as one model', () => {
    // Settings say "claude-fable-5[1m]", the usage endpoint says "Fable", and a
    // person says "fable". Comparing those as strings would never match.
    for (const spelling of ['Fable', 'fable', 'claude-fable-5[1m]', 'FABLE']) {
      expect(normalizeModel(spelling)).toBe('fable');
    }
    expect(normalizeModel('claude-opus-5')).toBe('opus');
    expect(normalizeModel('Sonnet')).toBe('sonnet');
  });

  it('leaves an unrecognised model alone rather than guessing', () => {
    expect(normalizeModel('some-future-model')).toBe('some-future-model');
  });
});

describe('hasRoomFor', () => {
  it('has room below the limit and none at it', () => {
    expect(hasRoomFor(account('a', { Fable: 0.4 }), 'fable')).toBe(true);
    expect(hasRoomFor(account('a', { Fable: 1 }), 'fable')).toBe(false);
  });

  it('has no room on any model when the whole account is out', () => {
    expect(hasRoomFor(account('a', { Fable: 0 }, true), 'fable')).toBe(false);
  });

  it('has no room when an ACCOUNT-WIDE window is spent, whatever the model says', () => {
    // A per-model number can look healthy while the account is out altogether,
    // and offering that account would send a session somewhere it cannot work.
    expect(hasRoomFor(account('a', { Fable: 0.1 }, true), 'fable')).toBe(false);
    expect(hasRoomFor(account('a', {}, true), 'opus')).toBe(false);
  });

  it('treats an unmeasured model as room, rather than stranding the account', () => {
    // Refusing to try an account nobody has read would strand a good one; the
    // worst case here is a single wasted attempt.
    expect(hasRoomFor(account('a', {}), 'fable')).toBe(true);
    expect(hasRoomFor(account('a', { Fable: null }), 'fable')).toBe(true);
  });
});
