import { describe, it, expect, vi } from 'vitest';
import { claimRawTerminal } from './raw-terminal.js';

/**
 * Why this is worth testing at all: a process that exits with the terminal still
 * in raw mode kills the shell it hands back. That was measured on Windows, where
 * a script exiting in raw mode killed the parent shell in every trial while
 * setting and restoring it was harmless in every trial. So "the restore always
 * happens" is the property, and the ways out that skip a `finally` are the risk.
 */

function fakes() {
  const modes: boolean[] = [];
  const written: string[] = [];
  const handlers = new Map<string, ((...a: unknown[]) => void)[]>();
  const stdin = {
    setRawMode: (v: boolean) => {
      modes.push(v);
    },
    resume: () => {},
    pause: () => {},
  } as unknown as NodeJS.ReadStream & { setRawMode?: (v: boolean) => void };
  const proc = {
    on: (event: string, fn: (...a: unknown[]) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      return proc;
    },
    off: (event: string, fn: (...a: unknown[]) => void) => {
      handlers.set(event, (handlers.get(event) ?? []).filter((f) => f !== fn));
      return proc;
    },
    exit: vi.fn() as unknown as (code?: number) => never,
  };
  const fire = (event: string, ...args: unknown[]): void => {
    for (const fn of handlers.get(event) ?? []) fn(...args);
  };
  return {
    modes,
    written,
    handlers,
    fire,
    proc,
    opts: {
      stdin,
      stdout: { write: (s: string) => written.push(s) },
      proc: proc as never,
      epilogue: '<restored>',
    },
  };
}

describe('claimRawTerminal', () => {
  it('takes raw mode, and gives it back on the normal path', () => {
    const f = fakes();
    const t = claimRawTerminal(f.opts);
    expect(f.modes).toEqual([true]);
    t.restore();
    expect(f.modes).toEqual([true, false]);
    expect(f.written).toEqual(['<restored>']);
  });

  it('gives it back on process exit, which is the path a crash takes', () => {
    // The dashboard's keypress handler runs on its own stack, so an exception
    // there ends the process without unwinding the loop's finally. This is the
    // net that catches exactly that.
    const f = fakes();
    claimRawTerminal(f.opts);
    f.fire('exit');
    expect(f.modes).toEqual([true, false]);
  });

  it('gives it back on Ctrl-C, then exits rather than swallowing the signal', () => {
    const f = fakes();
    claimRawTerminal(f.opts);
    f.fire('SIGINT', 'SIGINT');
    expect(f.modes).toEqual([true, false]);
    expect(f.proc.exit).toHaveBeenCalledWith(130);
  });

  it('restores once, however many times it is asked', () => {
    const f = fakes();
    const t = claimRawTerminal(f.opts);
    t.restore();
    t.restore();
    f.fire('exit');
    expect(f.modes).toEqual([true, false]); // exactly one restore
    expect(f.written).toEqual(['<restored>']);
  });

  it('stops listening once restored, so it cannot fire later', () => {
    const f = fakes();
    const t = claimRawTerminal(f.opts);
    t.restore();
    expect(f.handlers.get('exit')).toEqual([]);
    expect(f.handlers.get('SIGINT')).toEqual([]);
  });

  it('works on a terminal that cannot go raw at all', () => {
    const f = fakes();
    const plain = { resume: () => {}, pause: () => {} } as unknown as NodeJS.ReadStream;
    const t = claimRawTerminal({ ...f.opts, stdin: plain });
    expect(() => t.restore()).not.toThrow();
  });
});
