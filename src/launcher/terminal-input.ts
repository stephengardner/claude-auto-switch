/**
 * Ownership of the operator's keyboard for the lifetime of a `ccx run`.
 *
 * A run can host several claude sessions back to back (an account swap ends one
 * and starts the next). Each session used to take the terminal into raw mode,
 * resume stdin, attach a listener, then undo all of it on exit, so a swap
 * toggled global terminal state twice while a pseudo-terminal was being torn
 * down and another built. On Windows, where the terminal handle may itself be a
 * pseudo-terminal (VS Code / Cursor integrated terminals are), that churn is
 * exactly the kind of thing that destabilises the native layer.
 *
 * So the terminal is claimed ONCE per run and handed to whichever session is
 * current: sessions only swap the destination of the keystrokes, they never
 * touch the terminal's mode.
 */

import { createEscapeBuffer } from './escape-buffer.js';

type Writer = (data: string) => void;

export interface TerminalInput {
  /** Send keystrokes to `write` until the returned detach function is called. */
  attach(write: Writer): () => void;
  /** Restore the terminal and stop reading. Safe to call more than once. */
  close(): void;
}

type Stdin = NodeJS.ReadStream & {
  setRawMode?: (v: boolean) => void;
  unref?: () => void;
};

/** Claim the terminal for this run. */
export function openTerminalInput(stream: NodeJS.ReadStream = process.stdin): TerminalInput {
  const stdin = stream as Stdin;
  let target: Writer | null = null;
  let closed = false;

  // Normalize Enter: terminals may send \r\n or a lone \n, but the TUI submits
  // on \r. Without this, typing works but Enter never sends (MinTTY).
  const forEnter = (text: string): string => text.replace(/\r?\n/g, '\r');

  // Escape sequences are reassembled before being forwarded. A chunk boundary in
  // the middle of one used to deliver its halves as two separate writes, and the
  // reader then showed the tail as typed text: mouse reports turning up in the
  // prompt as "35;112;43M" with their ESC[< prefix gone.
  const buffer = createEscapeBuffer((held) => target?.(forEnter(held)));

  const onData = (d: Buffer): void => {
    const ready = buffer.push(d.toString('utf8'));
    if (ready) target?.(forEnter(ready));
  };

  // A real Windows console reports isTTY; Git Bash/MinTTY does not but still
  // needs raw mode where available. Try regardless and ignore failures.
  try {
    stdin.setRawMode?.(true);
  } catch {
    /* not a raw-capable stdin (e.g. a pipe) */
  }
  stdin.resume();
  stdin.on('data', onData);

  return {
    attach(write: Writer) {
      target = write;
      return () => {
        if (target === write) target = null;
      };
    },
    close() {
      if (closed) return;
      closed = true;
      target = null;
      stdin.off('data', onData);
      // Drops anything held mid-sequence, which is right at shutdown, and stops
      // its flush timer so nothing is left able to fire after the run has ended.
      buffer.drain();
      try {
        if (stdin.isTTY) stdin.setRawMode?.(false);
      } catch {
        /* ignore */
      }
      stdin.pause();
      // Release a piped stdin so it cannot keep the process alive after the
      // last session ends.
      stdin.unref?.();
    },
  };
}
