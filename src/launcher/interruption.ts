import { constants } from 'node:os';

/**
 * Ending a worker before its task is done, for the whole of its run.
 *
 * A worker is ended by whoever started it (Ctrl+C in a terminal, a program
 * stopping it) or by its own --timeout. While Claude runs, ending the worker
 * has to end Claude and everything Claude started, or they go on working in
 * the folder unwatched. Between launches (a login being renewed, the next
 * account being picked), ending at once would skip the session's own
 * clean-up, which saves a renewed login back to its account. So the end is
 * noted, the run in progress is stopped, and the swap loop ends at its next
 * step. A second signal ends the process at once, for when the first has not.
 */

export const ENDING_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** The exit code a shell reports for a process ended by `signal`: 128 plus its number. */
export function exitCodeForSignal(signal: NodeJS.Signals): number {
  return 128 + (constants.signals[signal] ?? 0);
}

export interface Interruption {
  /** The exit code the run ends with, once it has been ended; null until then. */
  readonly exitCode: number | null;
  /** Why it was ended, in words for the report; null until then. */
  readonly why: string | null;
  /** End the run: what is running is stopped, and nothing more starts. The first end counts. */
  end: (exitCode: number, why: string) => void;
  /** Told when the run is ended; the returned function stops telling it. */
  onEnd: (listener: () => void) => () => void;
  /** Stop handling the signals: Node's own handling applies again. */
  dispose: () => void;
}

/** Where the signals come from: the process, or a test's own emitter. */
export interface SignalSource {
  on: (event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void) => unknown;
  removeListener: (event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void) => unknown;
}

export function handleInterruption(
  exit: (code: number) => never = (code) => process.exit(code),
  signals: SignalSource = process,
): Interruption {
  let exitCode: number | null = null;
  let why: string | null = null;
  const listeners = new Set<() => void>();
  const end = (code: number, reason: string): void => {
    if (exitCode !== null) return;
    exitCode = code;
    why = reason;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* one listener failing must not keep the others from stopping */
      }
    }
  };
  const handler = (signal: NodeJS.Signals): void => {
    if (exitCode !== null) exit(exitCode);
    end(exitCodeForSignal(signal), `stopped by ${signal}`);
  };
  for (const name of ENDING_SIGNALS) signals.on(name, handler);
  return {
    get exitCode() {
      return exitCode;
    },
    get why() {
      return why;
    },
    end,
    onEnd: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      for (const name of ENDING_SIGNALS) signals.removeListener(name, handler);
      listeners.clear();
    },
  };
}
