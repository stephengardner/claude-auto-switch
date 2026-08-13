import { describe, it, expect } from 'vitest';
import { describeNextUp } from './next-up.js';
import { spentKey } from '../usage/rotation-plan.js';
import type { AccountModelUsage } from '../usage/model-preference.js';

function account(name: string, models: Record<string, number | null>, out = false): AccountModelUsage {
  return { name, models, ...(out ? { accountWideOut: true } : {}) };
}

const policy = { preference: ['fable', 'opus'], strategy: 'model-first' as const };

describe('saying where rotation goes next', () => {
  it('says STAYING HERE when the account in use still has room', () => {
    // The common case, and worth saying plainly: a dashboard full of numbers
    // does not answer "am I about to be moved" on its own.
    const said = describeNextUp({
      candidates: [account('second', { Fable: 0.53 }), account('main', { Fable: 1 })],
      current: 'second',
      modelInUse: 'fable',
      ...policy,
    });
    expect(said).toContain('staying here');
    expect(said).toContain('fable');
    expect(said).toContain('47% left');
  });

  it('names the account it will move to, when this one is spent', () => {
    const said = describeNextUp({
      candidates: [account('main', { Fable: 1 }), account('phx', { Fable: 0.2 })],
      current: 'main',
      modelInUse: 'fable',
      ...policy,
      spentThisRun: new Set([spentKey('main', 'fable')]),
    });
    expect(said).toContain('over on phx');
    expect(said).toContain('80% left');
  });

  it('says when the MODEL is what changes, not the account', () => {
    const said = describeNextUp({
      candidates: [account('solo', { Fable: 1, Opus: 0.1 })],
      current: 'solo',
      modelInUse: 'fable',
      ...policy,
      spentThisRun: new Set([spentKey('solo', 'fable')]),
    });
    expect(said).toContain('opus');
    expect(said).toContain('changed');
  });

  it('skips an account that is out for EVERY model, not just this one', () => {
    // accountWideOut is set from the usage snapshot when a five-hour or weekly
    // window is spent, and it means no model on that account will run. A
    // regression that dropped the flag on the way in would otherwise send the
    // operator to an account that cannot serve them at all.
    const said = describeNextUp({
      candidates: [account('spent', { Fable: 0.1 }, true), account('fine', { Fable: 0.4 })],
      current: null,
      modelInUse: 'fable',
      ...policy,
    });
    expect(said).toContain('fine');
    expect(said).not.toContain('spent');
  });

  it('reports honestly when there is nowhere left to go', () => {
    const said = describeNextUp({
      candidates: [account('a', { Fable: 1, Opus: 1 })],
      current: 'a',
      modelInUse: 'fable',
      ...policy,
    });
    expect(said).toContain('out of');
  });

  it('says nothing about room it has not measured', () => {
    // "100% left" about a window nobody has read would be a confident guess.
    const said = describeNextUp({
      candidates: [account('fresh', {})],
      current: null,
      modelInUse: 'fable',
      ...policy,
    });
    expect(said).toContain('fresh');
    expect(said).not.toContain('% left');
  });

  it('follows the account-first rule when that is what is configured', () => {
    const said = describeNextUp({
      candidates: [account('a', { Fable: 1, Opus: 0.3 }), account('b', { Fable: 0.1 })],
      current: 'a',
      modelInUse: 'fable',
      preference: ['fable', 'opus'],
      strategy: 'account-first',
      spentThisRun: new Set([spentKey('a', 'fable')]),
    });
    expect(said).toContain('staying here');
    expect(said).toContain('opus');
  });
});
