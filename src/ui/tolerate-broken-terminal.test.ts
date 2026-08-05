import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { tolerateBrokenTerminal, isTerminalGone } from './tolerate-broken-terminal.js';

const withCode = (code: string): NodeJS.ErrnoException => {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
};

describe('tolerateBrokenTerminal', () => {
  it('drops the errors that mean the other end has gone', () => {
    // These killed the dashboard about 60ms after pressing "l": the screen
    // handoff broke the pipe, and an 'error' with no listener is re-thrown by
    // Node as an uncaught exception.
    for (const code of ['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED']) {
      const stream = new EventEmitter();
      tolerateBrokenTerminal([stream]);
      expect(() => stream.emit('error', withCode(code))).not.toThrow();
    }
  });

  it('leaves a real fault alone so it still gets noticed', () => {
    // Swallowing everything would turn a genuine bug into a silent no-op, which
    // is the opposite failure and harder to find.
    const stream = new EventEmitter();
    tolerateBrokenTerminal([stream]);
    expect(() => stream.emit('error', withCode('EACCES'))).toThrow('EACCES');
  });

  it('covers BOTH directions, because reading keys fails the same way', () => {
    // The first version of this guarded only stdout and stderr, and the very
    // next run died on `read EPIPE` from stdin instead.
    const out = new EventEmitter();
    const err = new EventEmitter();
    const input = new EventEmitter();
    expect(tolerateBrokenTerminal([out, err, input])).toBe(3);
    for (const stream of [out, err, input]) {
      expect(() => stream.emit('error', withCode('EPIPE'))).not.toThrow();
    }
  });

  it('ignores anything that cannot take a listener', () => {
    expect(tolerateBrokenTerminal([undefined])).toBe(0);
  });

  it('recognises a gone terminal without needing a stream', () => {
    expect(isTerminalGone(withCode('EPIPE'))).toBe(true);
    expect(isTerminalGone(withCode('EACCES'))).toBe(false);
    expect(isTerminalGone(new Error('no code at all'))).toBe(false);
    expect(isTerminalGone(undefined)).toBe(false);
  });
});
