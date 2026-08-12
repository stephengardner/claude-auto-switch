import { describe, it, expect } from 'vitest';
import { planRotation, spentKey, type RotationPlanInput } from './rotation-plan.js';
import type { AccountModelUsage } from './model-preference.js';

/** An account with per-model utilization, 0..1. */
function account(name: string, models: Record<string, number | null>, accountWideOut = false): AccountModelUsage {
  return { name, models, ...(accountWideOut ? { accountWideOut: true } : {}) };
}

function plan(overrides: Partial<RotationPlanInput> = {}) {
  return planRotation({
    candidates: [],
    modelInUse: 'fable',
    preference: ['fable', 'opus'],
    strategy: 'model-first',
    spentThisRun: new Set<string>(),
    ...overrides,
  });
}

describe('staying on one model as long as possible (model-first)', () => {
  it('moves to ANOTHER ACCOUNT that still has the model, before changing model', () => {
    // The production failure. main ran out of Fable, so the run switched to
    // Opus immediately and stayed there, while phx had 24% of its Fable week
    // left. Ten rotations later it was sitting on phx running Opus.
    const result = plan({
      candidates: [
        account('main', { Fable: 1 }),
        account('second', { Fable: 1 }),
        account('phx', { Fable: 0.76 }),
      ],
      spentThisRun: new Set([spentKey('main', 'fable')]),
    });
    expect(result).toMatchObject({ kind: 'run', account: 'phx', model: 'fable', changedModel: false });
  });

  it('skips accounts whose model window is spent, in one pass', () => {
    const result = plan({
      candidates: [account('a', { Fable: 1 }), account('b', { Fable: 1 }), account('c', { Fable: 0.1 })],
    });
    expect(result).toMatchObject({ kind: 'run', account: 'c' });
  });

  it('changes model only once EVERY account is out of the current one', () => {
    const result = plan({
      candidates: [account('a', { Fable: 1, Opus: 0.2 }), account('b', { Fable: 1, Opus: 0.3 })],
      spentThisRun: new Set([spentKey('a', 'fable'), spentKey('b', 'fable')]),
    });
    expect(result).toMatchObject({ kind: 'run', account: 'a', model: 'opus', changedModel: true });
    if (result.kind === 'run') expect(result.reason).toContain('every account is out of fable');
  });

  it('goes back to the FIRST account when the model changes', () => {
    // The chain restarts: the operator's priority order applies again on the
    // new model, rather than continuing from wherever the last one ran out.
    const result = plan({
      candidates: [account('first', { Fable: 1 }), account('later', { Fable: 1 })],
      spentThisRun: new Set([spentKey('first', 'fable'), spentKey('later', 'fable')]),
    });
    expect(result).toMatchObject({ kind: 'run', account: 'first', model: 'opus' });
  });
});

describe('using each account up (account-first)', () => {
  it('changes model on THIS account before moving to the next one', () => {
    const result = plan({
      strategy: 'account-first',
      candidates: [account('a', { Fable: 1, Opus: 0.2 }), account('b', { Fable: 0.1 })],
      spentThisRun: new Set([spentKey('a', 'fable')]),
    });
    expect(result).toMatchObject({ kind: 'run', account: 'a', model: 'opus', changedModel: true });
  });

  it('moves on only when the account has nothing left in the chain', () => {
    const result = plan({
      strategy: 'account-first',
      candidates: [account('a', { Fable: 1, Opus: 1 }), account('b', { Fable: 0.1 })],
    });
    expect(result).toMatchObject({ kind: 'run', account: 'b', model: 'fable' });
  });
});

describe('never falling back', () => {
  it('reports exhaustion instead of running a model the operator did not choose', () => {
    // A one-model chain is how "only ever Fable" is expressed. Running Opus
    // here would be ccx choosing a model nobody asked for.
    const result = plan({
      preference: ['fable'],
      candidates: [account('a', { Fable: 1, Opus: 0.1 })],
      spentThisRun: new Set([spentKey('a', 'fable')]),
    });
    expect(result.kind).toBe('exhausted');
  });
});

describe('what the planner refuses to guess', () => {
  it('imposes no model, and does no model-aware picking, when none is pinned', () => {
    // Claude picks its own default and ccx cannot read it. Planning against
    // the preference here would plan for a model the session is not running:
    // it would pass over the pinned account because its FABLE is spent, while
    // the session might be on Opus and perfectly fine there.
    const result = plan({
      modelInUse: null,
      preference: ['fable', 'opus'],
      candidates: [account('pinned', { Fable: 1 }), account('spare', { Fable: 0.1 })],
    });
    expect(result).toMatchObject({ kind: 'run', account: 'pinned', model: null, changedModel: false });
  });

  it('treats an unmeasured model as room worth trying', () => {
    // Refusing to try an account nobody has measured strands a good one, and
    // the worst case is a single wasted attempt.
    const result = plan({ candidates: [account('unmeasured', {})] });
    expect(result).toMatchObject({ kind: 'run', account: 'unmeasured', model: 'fable' });
  });

  it('never picks an account whose whole window is closed', () => {
    const result = plan({
      candidates: [account('out', { Fable: 0.1 }, true), account('fine', { Fable: 0.2 })],
    });
    expect(result).toMatchObject({ kind: 'run', account: 'fine' });
  });

  it('keeps the model in use even when it is not in the configured chain', () => {
    // The operator is running it. Dropping it would move them off a model
    // that still has room just because it is not on a list.
    const result = plan({
      modelInUse: 'sonnet',
      preference: ['fable', 'opus'],
      candidates: [account('a', { Sonnet: 0.2, Fable: 0.1 })],
    });
    expect(result).toMatchObject({ kind: 'run', model: 'sonnet', changedModel: false });
  });

  it('says so plainly when there is nothing left anywhere', () => {
    const result = plan({
      candidates: [account('a', { Fable: 1, Opus: 1 }), account('b', { Fable: 1, Opus: 1 })],
    });
    expect(result.kind).toBe('exhausted');
  });

  it('is exhausted when there are no candidates at all', () => {
    expect(plan({ candidates: [] }).kind).toBe('exhausted');
  });

  it('matches models whatever their spelling', () => {
    // "Fable" on the wire, "fable" in config, "claude-fable-5" on a flag.
    const result = plan({
      modelInUse: 'claude-fable-5',
      candidates: [account('a', { Fable: 1 }), account('b', { Fable: 0.3 })],
      spentThisRun: new Set([spentKey('a', 'FABLE')]),
    });
    expect(result).toMatchObject({ kind: 'run', account: 'b', changedModel: false });
  });
});
