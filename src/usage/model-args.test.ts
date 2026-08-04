import { describe, it, expect } from 'vitest';
import { withModel, modelInArgs } from './model-args.js';

describe('withModel', () => {
  it('adds the model when there is none', () => {
    expect(withModel(['--continue'], 'opus')).toEqual(['--continue', '--model', 'opus']);
  });

  it('REPLACES a model already on the command line', () => {
    // The case that matters: an explicit `--model fable` is exactly when Fable
    // might be exhausted. Appending would leave the spent value first, or hand
    // the process two conflicting flags.
    expect(withModel(['--model', 'fable', '-p'], 'opus')).toEqual(['-p', '--model', 'opus']);
  });

  it('removes every earlier model, not just the first', () => {
    expect(withModel(['--model', 'a', '--model', 'b'], 'opus')).toEqual(['--model', 'opus']);
  });

  it('leaves other arguments in order', () => {
    expect(withModel(['-p', 'hello', '--model', 'fable', '--verbose'], 'opus')).toEqual([
      '-p',
      'hello',
      '--verbose',
      '--model',
      'opus',
    ]);
  });

  it('does not mutate what it was given', () => {
    const args = ['--model', 'fable'];
    withModel(args, 'opus');
    expect(args).toEqual(['--model', 'fable']);
  });
});

describe('modelInArgs', () => {
  it('finds the model when it is there', () => {
    expect(modelInArgs(['-p', '--model', 'fable'])).toBe('fable');
  });

  it('is null when there is none, or the flag has no value', () => {
    expect(modelInArgs(['-p'])).toBeNull();
    expect(modelInArgs(['--model'])).toBeNull();
  });
});
