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

  it('REPLACES the equals form too, which a parser accepts just the same', () => {
    // `--model=fable` and `--model fable` mean the same thing to the CLI, so
    // stripping only the spaced one would leave the spent model on the line.
    expect(withModel(['--model=fable', '-p'], 'opus')).toEqual(['-p', '--model', 'opus']);
    expect(withModel(['--model=fable', '--model', 'sonnet'], 'opus')).toEqual([
      '--model',
      'opus',
    ]);
  });

  it('does NOT touch --fallback-model, which is a different setting', () => {
    // It is the operator's own choice for when a model is overloaded, and it
    // is not the flag we are rotating.
    expect(withModel(['--fallback-model', 'sonnet'], 'opus')).toEqual([
      '--fallback-model',
      'sonnet',
      '--model',
      'opus',
    ]);
    expect(withModel(['--fallback-model=sonnet'], 'opus')).toEqual([
      '--fallback-model=sonnet',
      '--model',
      'opus',
    ]);
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

  it('does not swallow the NEXT OPTION as the model value', () => {
    // `--model --continue` has no value. Consuming `--continue` as one would
    // silently turn a resume into a fresh session.
    expect(withModel(['--model', '--continue'], 'opus')).toEqual([
      '--continue',
      '--model',
      'opus',
    ]);
    expect(withModel(['-p', '--model'], 'opus')).toEqual(['-p', '--model', 'opus']);
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

  it('finds the model in the equals form', () => {
    expect(modelInArgs(['-p', '--model=fable'])).toBe('fable');
  });

  it('is null when there is none, or the flag has no value', () => {
    expect(modelInArgs(['-p'])).toBeNull();
    expect(modelInArgs(['--model'])).toBeNull();
    expect(modelInArgs(['--model='])).toBeNull();
  });

  it('is null when --model is followed by another option, not a value', () => {
    expect(modelInArgs(['--model', '--continue'])).toBeNull();
  });

  it('rejects an option-like value in the equals form too', () => {
    // Both spellings must reject the same things, or `--model=--continue` gets
    // mistaken for a real pin while `--model --continue` does not.
    expect(modelInArgs(['--model=--continue'])).toBeNull();
    expect(modelInArgs(['--model=-c'])).toBeNull();
  });

  it('is not fooled by --fallback-model', () => {
    expect(modelInArgs(['--fallback-model', 'sonnet'])).toBeNull();
    expect(modelInArgs(['--fallback-model=sonnet'])).toBeNull();
  });
});
