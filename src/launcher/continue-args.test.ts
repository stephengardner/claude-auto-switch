import { describe, it, expect } from 'vitest';
import { wantsContinue, withoutContinue } from './continue-args.js';

describe('wantsContinue', () => {
  it('sees both spellings', () => {
    expect(wantsContinue(['--continue'])).toBe(true);
    expect(wantsContinue(['-p', '-c'])).toBe(true);
  });

  it('is false when neither is there', () => {
    expect(wantsContinue([])).toBe(false);
    expect(wantsContinue(['--model', 'opus'])).toBe(false);
  });

  it('is not fooled by a longer flag that starts the same way', () => {
    expect(wantsContinue(['--continue-session'])).toBe(false);
  });
});

describe('withoutContinue', () => {
  it('removes both spellings, and every one of them', () => {
    expect(withoutContinue(['--continue', '-p', '-c'])).toEqual(['-p']);
  });

  it('leaves everything else in order', () => {
    expect(withoutContinue(['--model', 'opus', '--continue', '-p'])).toEqual([
      '--model',
      'opus',
      '-p',
    ]);
  });

  it('does not mutate what it was given', () => {
    const args = ['--continue'];
    withoutContinue(args);
    expect(args).toEqual(['--continue']);
  });
});
