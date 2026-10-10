import { describe, it, expect } from 'vitest';
import { dispatchKey, dispatchSettingsKey, confirmKey } from './keys.js';

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

  it('asks to remove the highlighted account on x, in either case, without moving', () => {
    // Either case, like l: what keeps it safe is the typed answer the question
    // wants, not a key that caps lock turns into nothing.
    expect(dispatchKey('x', 120, 2, 4)).toEqual({ selected: 2, action: 'remove' });
    expect(dispatchKey('X', 88, 2, 4)).toEqual({ selected: 2, action: 'remove' });
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

describe('quitting with Escape', () => {
  it('quits on a bare Escape', () => {
    expect(dispatchKey('\x1b', 27, 0, 3).action).toBe('quit');
  });

  it('quits on a bare Escape even when byte0 is not supplied', () => {
    // byte0 is optional, so matching on it alone left this shape not quitting.
    expect(dispatchKey('', undefined, 0, 3).action).toBe('quit');
  });

  it('does NOT quit on an arrow key, which also starts with Escape', () => {
    // The whole reason this needs a length check: an arrow is `\x1b[A`, so
    // reading byte0 alone would close the dashboard every time you moved.
    expect(dispatchKey('\x1b[A', 27, 1, 3)).toEqual({ selected: 0, action: 'move' });
    expect(dispatchKey('\x1b[B', 27, 0, 3)).toEqual({ selected: 1, action: 'move' });
  });

  it('still quits on q, Ctrl-C and Ctrl-D', () => {
    expect(dispatchKey('q', 113, 0, 3).action).toBe('quit');
    expect(dispatchKey('\x03', 3, 0, 3).action).toBe('quit');
    expect(dispatchKey('\x04', 4, 0, 3).action).toBe('quit');
  });
});

describe('the Claude Desktop keys', () => {
  it('d, m and t change its settings, and capital D moves a conversation', () => {
    expect(dispatchKey('d', 100, 2, 3)).toEqual({ selected: 2, action: 'desktop-handoff' });
    expect(dispatchKey('m', 109, 2, 3).action).toBe('desktop-mode');
    expect(dispatchKey('t', 116, 2, 3).action).toBe('desktop-prompt');
    expect(dispatchKey('D', 68, 2, 3).action).toBe('desktop-move');
  });

  it('maps the rotation settings keys, without moving the cursor', () => {
    // M, not m: m is Desktop's. The brackets read as up and down the order.
    expect(dispatchKey('M', 77, 1, 3)).toEqual({ selected: 1, action: 'model-preference' });
    expect(dispatchKey('o', 111, 1, 3)).toEqual({ selected: 1, action: 'pick-order' });
    expect(dispatchKey('[', 91, 1, 3)).toEqual({ selected: 1, action: 'move-up' });
    expect(dispatchKey(']', 93, 1, 3)).toEqual({ selected: 1, action: 'move-down' });
  });

  it('opens the settings with s, without moving the cursor', () => {
    expect(dispatchKey('s', 115, 1, 3)).toEqual({ selected: 1, action: 'settings' });
  });
});

describe('dispatchSettingsKey', () => {
  it('steps back to the accounts on s or a bare Escape, rather than quitting', () => {
    expect(dispatchSettingsKey('s', 115, 2, 5).action).toBe('close');
    expect(dispatchSettingsKey('\x1b', 27, 2, 5).action).toBe('close');
  });

  it('still quits on q, Ctrl-C and Ctrl-D', () => {
    expect(dispatchSettingsKey('q', 113, 0, 5).action).toBe('quit');
    expect(dispatchSettingsKey('\x03', 3, 0, 5).action).toBe('quit');
    expect(dispatchSettingsKey('\x04', 4, 0, 5).action).toBe('quit');
  });

  it('moves between settings with j/k and the up/down arrows, clamped', () => {
    expect(dispatchSettingsKey('j', 106, 0, 5)).toEqual({ selected: 1, action: 'move' });
    expect(dispatchSettingsKey('\x1b[B', 27, 4, 5)).toEqual({ selected: 4, action: 'move' });
    expect(dispatchSettingsKey('k', 107, 0, 5)).toEqual({ selected: 0, action: 'move' });
    expect(dispatchSettingsKey('\x1b[A', 27, 3, 5)).toEqual({ selected: 2, action: 'move' });
  });

  it('steps a value on with the right arrow, space or +, and back with the left arrow or -', () => {
    for (const key of ['\x1b[C', ' ', '+', '=']) expect(dispatchSettingsKey(key, key.charCodeAt(0), 1, 5).action).toBe('next');
    for (const key of ['\x1b[D', '-']) expect(dispatchSettingsKey(key, key.charCodeAt(0), 1, 5).action).toBe('previous');
  });

  it('edits on Enter, resets on d, and ignores the rest', () => {
    expect(dispatchSettingsKey('\r', 13, 1, 5).action).toBe('edit');
    expect(dispatchSettingsKey('d', 100, 1, 5).action).toBe('default');
    expect(dispatchSettingsKey('z', 122, 1, 5)).toEqual({ selected: 1, action: 'none' });
  });
});
