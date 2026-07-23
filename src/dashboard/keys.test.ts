import { describe, it, expect } from 'vitest';
import { dispatchKey } from './keys.js';

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

  it('maps p/e/r to pin/toggle/rotate without moving', () => {
    expect(dispatchKey('p', undefined, 1, 3)).toEqual({ selected: 1, action: 'pin' });
    expect(dispatchKey('e', undefined, 1, 3)).toEqual({ selected: 1, action: 'toggle' });
    expect(dispatchKey('r', undefined, 1, 3)).toEqual({ selected: 1, action: 'rotate' });
  });

  it('ignores unknown keys', () => {
    expect(dispatchKey('z', undefined, 1, 3)).toEqual({ selected: 1, action: 'none' });
  });
});
