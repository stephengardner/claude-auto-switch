import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { ENDING_SIGNALS, exitCodeForSignal, handleInterruption } from './interruption.js';

/**
 * A worker ended by its caller, or by its own timeout, stops Claude and still
 * cleans up after itself; a second signal ends it at once. Signals come from
 * an emitter of the test's own: emitting them on the process would reach the
 * test runner's own handlers too.
 */

const never = (): never => {
  throw new Error('ended at once');
};
describe('ending a worker', () => {
  it('notes a signal, with the exit code a shell would show, and tells whoever is listening', () => {
    const signals = new EventEmitter();
    const interruption = handleInterruption(never, signals);
    try {
      let told = 0;
      interruption.onEnd(() => {
        told += 1;
      });
      signals.emit('SIGTERM', 'SIGTERM');
      expect(interruption.exitCode).toBe(exitCodeForSignal('SIGTERM'));
      expect(interruption.why).toBe('stopped by SIGTERM');
      expect(told).toBe(1);
    } finally {
      interruption.dispose();
    }
  });

  it('keeps the first end: a timeout after a signal changes nothing', () => {
    const interruption = handleInterruption(never, new EventEmitter());
    try {
      interruption.end(124, 'timed out');
      interruption.end(1, 'something later');
      expect(interruption.exitCode).toBe(124);
      expect(interruption.why).toBe('timed out');
    } finally {
      interruption.dispose();
    }
  });

  it('ends at once on a signal after the run was already ended', () => {
    const codes: number[] = [];
    const signals = new EventEmitter();
    const interruption = handleInterruption((code) => {
      codes.push(code);
      throw new Error('ended');
    }, signals);
    try {
      signals.emit('SIGINT', 'SIGINT');
      expect(() => signals.emit('SIGINT', 'SIGINT')).toThrow('ended');
      expect(codes).toEqual([exitCodeForSignal('SIGINT')]);
    } finally {
      interruption.dispose();
    }
  });

  it('hands the signals back when the run is over', () => {
    const signals = new EventEmitter();
    const interruption = handleInterruption(never, signals);
    expect(ENDING_SIGNALS.map((name) => signals.listenerCount(name))).toEqual([1, 1, 1]);
    interruption.dispose();
    expect(ENDING_SIGNALS.map((name) => signals.listenerCount(name))).toEqual([0, 0, 0]);
  });

  it('reports the shell exit code for a signal', () => {
    expect(exitCodeForSignal('SIGINT')).toBe(130);
    expect(exitCodeForSignal('SIGTERM')).toBe(143);
  });
});
