import { describe, it, expect } from 'vitest';
import {
  normalizeModel,
  hasRoomFor,
  chooseAccountForModel,
  modelChangeMessage,
  type AccountModelUsage,
} from './model-preference.js';

const DEFAULT_ORDER = ['fable', 'opus'];

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

  it('treats an unmeasured model as room, rather than stranding the account', () => {
    // Refusing to try an account nobody has read would strand a good one; the
    // worst case here is a single wasted attempt.
    expect(hasRoomFor(account('a', {}), 'fable')).toBe(true);
    expect(hasRoomFor(account('a', { Fable: null }), 'fable')).toBe(true);
  });
});

describe('chooseAccountForModel', () => {
  it('STAYS on the model in use, moving to an account that still has it', () => {
    // The whole request: a session on Fable should look for Fable elsewhere
    // before it considers anything else.
    const choice = chooseAccountForModel(
      'fable',
      [account('spent', { Fable: 1 }), account('has-fable', { Fable: 0.2 })],
      DEFAULT_ORDER,
    );
    expect(choice).toEqual({ account: 'has-fable', model: 'fable', changedModel: false });
  });

  it('changes model ONLY when no account has room on the current one', () => {
    const choice = chooseAccountForModel(
      'fable',
      [account('a', { Fable: 1, Opus: 0.3 }), account('b', { Fable: 1, Opus: 0.1 })],
      DEFAULT_ORDER,
    );
    expect(choice?.model).toBe('opus');
    expect(choice?.changedModel).toBe(true);
    expect(choice?.account).toBe('a'); // first in the given order, which is priority
  });

  it('prefers the model in use even when it is later in the configured order', () => {
    // Staying put beats the preference list: changing someone's model mid-session
    // is disruptive, and the order only decides where to go once that is forced.
    const choice = chooseAccountForModel(
      'opus',
      [account('a', { Fable: 0.1, Opus: 0.5 })],
      ['fable', 'opus'],
    );
    expect(choice?.model).toBe('opus');
    expect(choice?.changedModel).toBe(false);
  });

  it('follows a configured order when the model in use is exhausted everywhere', () => {
    const choice = chooseAccountForModel(
      'fable',
      [account('a', { Fable: 1, Opus: 0.2, Sonnet: 0.1 })],
      ['sonnet', 'opus'],
    );
    expect(choice?.model).toBe('sonnet');
  });

  it('returns nothing when everything is out, instead of guessing', () => {
    expect(
      chooseAccountForModel(
        'fable',
        [account('a', { Fable: 1, Opus: 1 }), account('b', {}, true)],
        DEFAULT_ORDER,
      ),
    ).toBeNull();
  });

  it('respects the order it is given, which carries priority and pinning', () => {
    const choice = chooseAccountForModel(
      'fable',
      [account('first', { Fable: 0.9 }), account('second', { Fable: 0.1 })],
      DEFAULT_ORDER,
    );
    // Not the emptiest: the caller has already decided the order it wants tried.
    expect(choice?.account).toBe('first');
  });

  it('uses the preference chain when the session has no model pinned', () => {
    const choice = chooseAccountForModel(
      null,
      [account('a', { Fable: 1, Opus: 0.2 })],
      DEFAULT_ORDER,
    );
    expect(choice).toEqual({ account: 'a', model: 'opus', changedModel: false });
  });

  it('matches models across spellings, not by string equality', () => {
    const choice = chooseAccountForModel(
      'claude-fable-5[1m]',
      [account('a', { Fable: 1 }), account('b', { Fable: 0.1 })],
      DEFAULT_ORDER,
    );
    expect(choice?.account).toBe('b');
  });
});

describe('modelChangeMessage', () => {
  it('says what changed and where it went', () => {
    const message = modelChangeMessage(
      { account: 'work', model: 'opus', changedModel: true },
      'Fable',
    );
    expect(message).toContain('out of Fable');
    expect(message).toContain('opus');
    expect(message).toContain('work');
  });
});
