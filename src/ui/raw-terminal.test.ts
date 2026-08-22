import { describe, it, expect, vi } from 'vitest';
import { claimRawTerminal, type RawTerminalOptions } from './raw-terminal.js';

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
    kill: vi.fn(),
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

  it('gives it back on Ctrl-C, rather than swallowing the signal', () => {
    // Superseded in detail by the re-raise test below: what matters at this
    // level is that the terminal is handed back and the signal is not eaten.
    const f = fakes();
    claimRawTerminal(f.opts);
    f.fire('SIGINT', 'SIGINT');
    expect(f.modes).toEqual([true, false]);
    expect(f.proc.kill).toHaveBeenCalled();
  });

  it('re-raises the signal rather than exiting from inside the handler', () => {
    // Ending the program from a signal handler skips the caller own teardown
    // and, on Windows, races the console being torn down. Re-raising gives the
    // ordinary behaviour and the ordinary exit status.
    const f = fakes();
    claimRawTerminal(f.opts);
    f.fire('SIGINT', 'SIGINT');
    expect(f.modes).toEqual([true, false]); // terminal handed back first
    expect(f.proc.kill).toHaveBeenCalledWith(process.pid, 'SIGINT');
    expect(f.proc.exit).not.toHaveBeenCalled();
  });

  it('lets an owner wind down on its own terms instead', () => {
    const f = fakes();
    const ended: string[] = [];
    claimRawTerminal({ ...f.opts, onEnd: (s) => ended.push(s) });
    f.fire('SIGINT', 'SIGINT');
    expect(ended).toEqual(['SIGINT']);
    expect(f.modes).toEqual([true, false]); // still handed back first
    expect(f.proc.kill).not.toHaveBeenCalled();
    expect(f.proc.exit).not.toHaveBeenCalled();
  });

  it('still ends the program when the process cannot be signalled at all', () => {
    // Optional chaining on a missing kill would swallow the call, leaving the
    // program neither exiting nor re-raising: stuck after a Ctrl-C.
    const f = fakes();
    delete (f.proc as { kill?: unknown }).kill;
    claimRawTerminal(f.opts);
    f.fire('SIGINT', 'SIGINT');
    expect(f.modes).toEqual([true, false]);
    expect(f.proc.exit).toHaveBeenCalledWith(130);
  });

  it('reports the conventional exit code for each signal, not one for all', () => {
    // 128 + signal number. A supervisor and a shell $? check both read this, so
    // reporting every signal as if it were SIGTERM is a lie where people look.
    // Only reached when re-raising is not possible; then the conventional
    // 128+signal code still stands in.
    for (const [signal, code] of [
      ['SIGHUP', 129],
      ['SIGINT', 130],
      ['SIGTERM', 143],
      ['SIGBREAK', 149],
    ] as const) {
      const f = fakes();
      f.proc.kill = vi.fn(() => {
        throw new Error('cannot signal');
      });
      claimRawTerminal(f.opts);
      f.fire(signal, signal);
      expect(f.modes).toEqual([true, false]); // terminal handed back first
      expect(f.proc.exit).toHaveBeenCalledWith(code);
    }
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

describe('a restore that does not take', () => {
  /**
   * A stdin whose setRawMode silently fails to clear the flag. That is the
   * transient case worth surviving: the terminal is still raw, and if the
   * restore reports itself done anyway, the process-exit safety net returns
   * early and the shell inherits a console mode it never set. On Windows that
   * kills the shell, which is the intermittent "q closed my whole terminal".
   */
  function stubbornStdin(clearAfter: number) {
    let attempts = 0;
    const stdin = {
      isRaw: false,
      setRawMode(v: boolean) {
        if (v) {
          stdin.isRaw = true;
          return;
        }
        attempts += 1;
        if (attempts >= clearAfter) stdin.isRaw = false;
      },
      resume: () => {},
      pause: () => {},
    };
    return { stdin, attempts: () => attempts };
  }

  function procSpy() {
    const handlers = new Map<string, ((...a: unknown[]) => void)[]>();
    const proc = {
      on: (event: string, fn: (...a: unknown[]) => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), fn]);
        return proc;
      },
      off: (event: string, fn: (...a: unknown[]) => void) => {
        handlers.set(event, (handlers.get(event) ?? []).filter((f) => f !== fn));
        return proc;
      },
    };
    const count = (event: string): number => (handlers.get(event) ?? []).length;
    const fire = (event: string): void => {
      for (const fn of [...(handlers.get(event) ?? [])]) fn();
    };
    return { proc, count, fire };
  }

  it('retries, and clears raw mode on the second attempt', () => {
    const { stdin, attempts } = stubbornStdin(2);
    const { proc } = procSpy();
    const term = claimRawTerminal({
      stdin: stdin as unknown as NodeJS.ReadStream & { setRawMode?: (v: boolean) => void },
      stdout: { write: () => true },
      proc: proc as unknown as RawTerminalOptions['proc'],
    });
    expect(stdin.isRaw).toBe(true);
    term.restore();
    expect(attempts()).toBe(2);
    expect(stdin.isRaw).toBe(false);
  });

  it('keeps the exit hook armed while the terminal is still raw', () => {
    // Never clears, so restore cannot honestly report success. Releasing the
    // exit hook here is what disarmed the last line of defence.
    const { stdin } = stubbornStdin(Number.MAX_SAFE_INTEGER);
    const { proc, count } = procSpy();
    const term = claimRawTerminal({
      stdin: stdin as unknown as NodeJS.ReadStream & { setRawMode?: (v: boolean) => void },
      stdout: { write: () => true },
      proc: proc as unknown as RawTerminalOptions['proc'],
    });
    expect(count('exit')).toBe(1);
    term.restore();
    expect(stdin.isRaw).toBe(true);
    // Both kinds of hook stay armed: the signal handlers are released in the
    // same breath as the exit one, so checking only exit would miss half of it.
    expect(count('exit')).toBe(1);
    expect(count('SIGINT')).toBe(1);

    // And when the stream recovers, the next attempt completes and stands down.
    stdin.isRaw = false;
    term.restore();
    expect(count('exit')).toBe(0);
    expect(count('SIGINT')).toBe(0);
  });

  it('releases the hooks once the terminal really is back', () => {
    const { stdin } = stubbornStdin(1);
    const { proc, count } = procSpy();
    const term = claimRawTerminal({
      stdin: stdin as unknown as NodeJS.ReadStream & { setRawMode?: (v: boolean) => void },
      stdout: { write: () => true },
      proc: proc as unknown as RawTerminalOptions['proc'],
    });
    term.restore();
    expect(stdin.isRaw).toBe(false);
    expect(count('exit')).toBe(0);
  });
});
