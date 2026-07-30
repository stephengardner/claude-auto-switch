/**
 * Holding the keyboard without wrecking the terminal on the way out.
 *
 * Leaving the terminal in raw mode when a process exits is not a cosmetic
 * problem: the shell that gets it back is left with an input mode it did not set,
 * and on Windows it typically dies on the spot, taking the window with it. That
 * was measured: a process that exits with raw mode still on killed the shell in
 * every trial, while setting and restoring it was harmless in every trial.
 *
 * A `finally` block is not enough on its own, because the ways out of a terminal
 * program include the ones that skip it: an exception thrown from a keypress
 * handler (which runs on its own stack, not inside the loop), a signal, or a
 * direct exit. So the restore is registered with the process itself, and running
 * twice is harmless.
 */

export interface RawTerminal {
  /** Put the terminal back. Safe to call more than once. */
  restore: () => void;
}

export interface RawTerminalOptions {
  /** Written once on the way out, for cursor and screen restore sequences. */
  epilogue?: string;
  stdin?: NodeJS.ReadStream & { setRawMode?: (v: boolean) => void };
  stdout?: { write: (s: string) => unknown };
  /** Injected in tests instead of the real process. */
  proc?: Pick<NodeJS.Process, 'on' | 'off'> & { exit?: (code?: number) => never };
}

/**
 * The conventional exit code for each signal: 128 plus the signal number. A
 * supervisor and a shell `$?` check both read this, so reporting every signal as
 * if it were SIGTERM would be a small lie in the one place people look.
 */
const SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
  SIGBREAK: 149,
};

const SIGNALS = Object.keys(SIGNAL_EXIT_CODES) as NodeJS.Signals[];

/**
 * Take the keyboard, and guarantee it is handed back.
 *
 * Returns the restore function for the normal path; the same function is wired to
 * process exit and to signals, so an unexpected end restores the terminal too.
 */
export function claimRawTerminal(options: RawTerminalOptions = {}): RawTerminal {
  const stdin = options.stdin ?? (process.stdin as RawTerminalOptions['stdin'])!;
  const stdout = options.stdout ?? process.stdout;
  const proc = options.proc ?? process;

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    try {
      stdin.setRawMode?.(false);
    } catch {
      /* not raw-capable; nothing to undo */
    }
    try {
      stdin.pause();
    } catch {
      /* already closed */
    }
    if (options.epilogue) {
      try {
        stdout.write(options.epilogue);
      } catch {
        /* the terminal is already gone */
      }
    }
    proc.off('exit', restore);
    for (const signal of SIGNALS) proc.off(signal, onSignal);
  };

  // A signal would otherwise end the process with the terminal still raw.
  function onSignal(signal: NodeJS.Signals): void {
    restore();
    // Re-raise the default behaviour: having a handler suppressed it, and a
    // terminal program that swallows Ctrl-C is its own kind of broken.
    (proc.exit ?? process.exit)(SIGNAL_EXIT_CODES[signal] ?? 143);
  }

  try {
    stdin.setRawMode?.(true);
  } catch {
    /* not raw-capable: carry on, there is nothing to restore either */
  }
  stdin.resume();

  proc.on('exit', restore);
  for (const signal of SIGNALS) proc.on(signal, onSignal);

  return { restore };
}
