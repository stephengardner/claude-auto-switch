import { describe, it, expect } from 'vitest';
import { nextModel } from './next-model.js';

describe('nextModel', () => {
  it('falls back to Opus when Fable is spent', () => {
    // The operator's ask, in one line: if Fable runs out, try Opus, and start.
    expect(nextModel(['fable', 'opus'], ['Fable'])).toBe('opus');
  });

  it('starts at the front of the chain when nothing is spent', () => {
    expect(nextModel(['fable', 'opus'], [])).toBe('fable');
  });

  it('matches whatever case the API used', () => {
    // The usage endpoint says "Fable"; the config says "fable". Missing that
    // would keep handing back a model that is already gone, forever.
    expect(nextModel(['fable', 'opus'], ['FABLE'])).toBe('opus');
    expect(nextModel(['Fable', 'Opus'], ['fable'])).toBe('Opus');
    expect(nextModel(['fable', 'opus'], [' Fable '])).toBe('opus');
  });

  it('returns null only when the whole chain is spent', () => {
    // This is what makes the loop terminate instead of retrying a dead model.
    expect(nextModel(['fable', 'opus'], ['fable', 'opus'])).toBeNull();
  });

  it('honours the operator order rather than picking whatever is free', () => {
    expect(nextModel(['opus', 'fable'], [])).toBe('opus');
  });

  it('handles an empty chain without throwing', () => {
    expect(nextModel([], [])).toBeNull();
  });
});
