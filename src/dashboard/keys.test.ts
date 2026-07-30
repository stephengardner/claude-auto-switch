import { describe, it, expect } from 'vitest';
import { dispatchKey, confirmKey } from './keys.js';

describe('dispatchKey', () => {
  it('quits on q, Ctrl-C, Ctrl-D', () => {
    expect(dispatchKey('q', 113, 0, 3).action).toBe('quit');
    expect(dispatchKey('\x03', 3, 0, 3).action).toBe('quit');
    expect(dispatchKey('\x04', 4, 0, 3).action).toBe('quit');
  });

  it('moves down with j / down-arrow, clamped to the last row', () => {
    expect(dispatchKey('j', undefined, 0, 3)).toEqual({ selected: 1, action: 'move' });
    expect(dispatchKey('\x1b[B', undefined, 2, 3)).toEqual({ selected: 2, action: 'move' });
  });

  it('moves up with k / up-arrow, clamped to the first row', () => {
    expect(dispatchKey('k', undefined, 2, 3)).toEqual({ selected: 1, action: 'move' });
    expect(dispatchKey('\x1b[A', undefined, 0, 3)).toEqual({ selected: 0, action: 'move' });
  });

  it('activates the selected row (use) on Enter, u, or p', () => {
    expect(dispatchKey('\r', 13, 1, 3)).toEqual({ selected: 1, action: 'use' });
    expect(dispatchKey('\n', 10, 1, 3)).toEqual({ selected: 1, action: 'use' });
    expect(dispatchKey('u', 117, 1, 3)).toEqual({ selected: 1, action: 'use' });
    expect(dispatchKey('p', 112, 1, 3)).toEqual({ selected: 1, action: 'use' });
  });

  it('maps f to force (instant switch) without moving', () => {
    expect(dispatchKey('f', 102, 1, 3)).toEqual({ selected: 1, action: 'force' });
  });

  it('maps e/r to toggle/rotate without moving', () => {
    expect(dispatchKey('e', undefined, 1, 3)).toEqual({ selected: 1, action: 'toggle' });
    expect(dispatchKey('r', undefined, 1, 3)).toEqual({ selected: 1, action: 'rotate' });
  });

  it('ignores unknown keys', () => {
    expect(dispatchKey('z', undefined, 1, 3)).toEqual({ selected: 1, action: 'none' });
  });

  it('asks to sign the highlighted account in again, in EITHER case', () => {
    // Lower case matters: it is what people actually press, and it is what was
    // reported as broken. Hiding the action behind shift did not make it safe,
    // it made it undiscoverable. Safety comes from the confirmation instead.
    expect(dispatchKey('l', 108, 1, 3).action).toBe('login');
    expect(dispatchKey('L', 76, 1, 3).action).toBe('login');
  });

  it('does not move the selection when asking to sign in', () => {
    expect(dispatchKey('l', 108, 2, 4).selected).toBe(2);
  });
});

describe('confirmKey', () => {
  it('takes y or Enter as yes', () => {
    expect(confirmKey('y', 121)).toBe('yes');
    expect(confirmKey('Y', 89)).toBe('yes');
    expect(confirmKey('\r', 13)).toBe('yes');
    expect(confirmKey('\n', 10)).toBe('yes');
  });

  it('treats everything else as no, including keys that mean something elsewhere', () => {
    // The question takes the next key whatever it is, so answering it can never
    // also trigger another action.
    const others: Array<[string, number]> = [
      ['n', 110],
      ['q', 113],
      ['j', 106],
      ['\x1b', 27],
      ['\x03', 3],
    ];
    for (const [key, byte0] of others) {
      expect(confirmKey(key, byte0)).toBe('no');
    }
  });
});
