import { describe, it, expect } from 'vitest';
import {
  markCapped,
  isCapped,
  cappedNames,
  clearExpired,
  clearAccount,
  modelCappedNames,
  allLimitedNames,
  modelOnlyLimit,
  activeModelCaps,
} from './ledger.js';
import type { Ledger } from './ledger.schema.js';

const empty: Ledger = { caps: [] };
const MIN = 60_000;

describe('ledger', () => {
  it('marks an account capped with a backoff window when no reset time is known', () => {
    const l = markCapped(empty, { account: 'a', now: 1000, backoffMinutes: 5 });
    expect(isCapped(l, 'a', 1000)).toBe(true);
    expect(isCapped(l, 'a', 1000 + 5 * MIN - 1)).toBe(true);
    expect(isCapped(l, 'a', 1000 + 5 * MIN + 1)).toBe(false);
  });

  it('uses an explicit reset time when provided (over the backoff)', () => {
    const l = markCapped(empty, { account: 'a', now: 1000, resetAt: 50_000, backoffMinutes: 999 });
    expect(isCapped(l, 'a', 49_999)).toBe(true);
    expect(isCapped(l, 'a', 50_001)).toBe(false);
  });

  it('replaces a prior cap for the same account', () => {
    let l = markCapped(empty, { account: 'a', now: 0, resetAt: 100 });
    l = markCapped(l, { account: 'a', now: 0, resetAt: 200 });
    expect(l.caps).toHaveLength(1);
    expect(isCapped(l, 'a', 150)).toBe(true);
  });

  it('cappedNames lists only currently-capped accounts', () => {
    let l = markCapped(empty, { account: 'a', now: 0, resetAt: 100 });
    l = markCapped(l, { account: 'b', now: 0, resetAt: 10 });
    expect(cappedNames(l, 50)).toEqual(new Set(['a']));
  });

  it('clearExpired drops caps whose window has passed', () => {
    let l = markCapped(empty, { account: 'a', now: 0, resetAt: 100 });
    l = markCapped(l, { account: 'b', now: 0, resetAt: 10 });
    expect(clearExpired(l, 50).caps.map((c) => c.account)).toEqual(['a']);
  });

  it('clearAccount removes an account cap after a successful run', () => {
    const l = markCapped(empty, { account: 'a', now: 0, resetAt: 100 });
    expect(isCapped(clearAccount(l, 'a'), 'a', 50)).toBe(false);
  });
});

describe('what rotation can learn from limits recorded earlier', () => {
  const now = 2_000_000;
  const later = now + 60 * 60_000;

  it('reports the (account, model) pairs that are spent right now', () => {
    // Rotation plans from what it measured plus what it proved this run, and
    // neither sees a limit an earlier run confirmed. Without this, a fresh run
    // hands a model straight back to the account that just ran out of it.
    let ledger = markCapped({ caps: [] }, { account: 'main', now, resetAt: later, model: 'Fable' });
    ledger = markCapped(ledger, { account: 'phx', now, resetAt: later, model: 'Opus' });
    expect(activeModelCaps(ledger, now)).toEqual([
      { account: 'main', model: 'Fable' },
      { account: 'phx', model: 'Opus' },
    ]);
  });

  it('reads differently cased names as ONE model, wherever they came from', () => {
    // "Fable" from the usage API, "fable" from config, "claude-fable-5" from a
    // flag. A strict comparison here read two accounts out of the same model
    // as a mixed situation, so the last-resort path gave up instead of saying
    // which model was out and starting anyway.
    let ledger = markCapped({ caps: [] }, { account: 'a', now, resetAt: later, model: 'Fable' });
    ledger = markCapped(ledger, { account: 'b', now, resetAt: later + 5, model: 'fable' });
    const limit = modelOnlyLimit(ledger, now);
    expect(limit).not.toBeNull();
    expect(limit?.model).toBe('Fable');
    expect(limit?.resetsAt).toBe(later);
    expect(modelCappedNames(ledger, now, 'FABLE')).toEqual(new Set(['a', 'b']));
  });

  it('keeps one record PER MODEL on an account', () => {
    // Writing a cap used to drop every record for the account, so capping
    // Fable and then Opus erased the Fable one, and the next run offered Fable
    // back to an account whose Fable window was demonstrably closed.
    let ledger = markCapped({ caps: [] }, { account: 'a', now, resetAt: later, model: 'Fable' });
    ledger = markCapped(ledger, { account: 'a', now, resetAt: later, model: 'Opus' });
    expect(activeModelCaps(ledger, now)).toEqual([
      { account: 'a', model: 'Fable' },
      { account: 'a', model: 'Opus' },
    ]);
  });

  it('replaces the record for the SAME model rather than adding another', () => {
    let ledger = markCapped({ caps: [] }, { account: 'a', now, resetAt: later, model: 'Fable' });
    ledger = markCapped(ledger, { account: 'a', now, resetAt: later + 5, model: 'fable' });
    expect(activeModelCaps(ledger, now)).toEqual([{ account: 'a', model: 'fable' }]);
  });

  it('an account-wide limit replaces every record for that account', () => {
    // Nothing about the account is usable, so per-model detail is only noise.
    let ledger = markCapped({ caps: [] }, { account: 'a', now, resetAt: later, model: 'Fable' });
    ledger = markCapped(ledger, { account: 'a', now, resetAt: later });
    expect(activeModelCaps(ledger, now)).toEqual([]);
    expect(isCapped(ledger, 'a', now)).toBe(true);
  });

  it('leaves out account-wide limits, which are a different question', () => {
    // Those already remove the account entirely, via cappedNames.
    const ledger = markCapped({ caps: [] }, { account: 'main', now, resetAt: later });
    expect(activeModelCaps(ledger, now)).toEqual([]);
  });

  it('forgets a pair once its window has reopened', () => {
    const ledger = markCapped({ caps: [] }, { account: 'main', now, resetAt: later, model: 'Fable' });
    expect(activeModelCaps(ledger, later + 1)).toEqual([]);
  });
});

describe('limits scoped to one model', () => {
  const now = 1_000_000;
  const later = now + 60 * 60_000;

  it('does NOT make an account unusable: other models still work', () => {
    // The bug this prevents: a spent Fable window stopped `claude --model opus`
    // from starting at all, and reported it as being signed out.
    const ledger = markCapped(
      { caps: [] },
      { account: 'work', now, resetAt: later, model: 'Fable' },
    );
    expect(isCapped(ledger, 'work', now)).toBe(false);
    expect(cappedNames(ledger, now).has('work')).toBe(false);
    // It is still recorded, for display and for steering rotation.
    expect(modelCappedNames(ledger, now).has('work')).toBe(true);
    expect(modelCappedNames(ledger, now, 'Fable').has('work')).toBe(true);
    expect(modelCappedNames(ledger, now, 'Opus').has('work')).toBe(false);
    expect(allLimitedNames(ledger, now).has('work')).toBe(true);
  });

  it('an account-wide limit still makes the account unusable', () => {
    const ledger = markCapped({ caps: [] }, { account: 'work', now, resetAt: later });
    expect(isCapped(ledger, 'work', now)).toBe(true);
    expect(cappedNames(ledger, now).has('work')).toBe(true);
    expect(modelCappedNames(ledger, now).has('work')).toBe(false);
  });

  it('modelOnlyLimit reports the model and soonest reset when every limit is that model', () => {
    let ledger = markCapped({ caps: [] }, { account: 'a', now, resetAt: later, model: 'Fable' });
    ledger = markCapped(ledger, { account: 'b', now, resetAt: later + 60_000, model: 'Fable' });
    expect(modelOnlyLimit(ledger, now)).toEqual({ model: 'Fable', resetsAt: later });
  });

  it('modelOnlyLimit is null when anything is limited account-wide, or models differ', () => {
    let mixed = markCapped({ caps: [] }, { account: 'a', now, resetAt: later, model: 'Fable' });
    mixed = markCapped(mixed, { account: 'b', now, resetAt: later }); // account-wide
    expect(modelOnlyLimit(mixed, now)).toBeNull();

    let twoModels = markCapped({ caps: [] }, { account: 'a', now, resetAt: later, model: 'Fable' });
    twoModels = markCapped(twoModels, { account: 'b', now, resetAt: later, model: 'Opus' });
    expect(modelOnlyLimit(twoModels, now)).toBeNull();

    expect(modelOnlyLimit({ caps: [] }, now)).toBeNull();
  });

  it('an expired model limit stops counting', () => {
    const ledger = markCapped({ caps: [] }, { account: 'a', now, resetAt: now - 1, model: 'Fable' });
    expect(modelOnlyLimit(ledger, now)).toBeNull();
    expect(modelCappedNames(ledger, now).size).toBe(0);
  });
});
