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
import { createMouseGate, STOP_UNREQUESTED_MOTION, type MouseGate } from './mouse-gate.js';

type Writer = (data: string) => void;

export interface TerminalInput {
  /** Send keystrokes to `write` until the returned detach function is called. */
  attach(write: Writer): () => void;
  /**
   * Tell the relay what the child just wrote, so it knows which mouse reports
   * that child has actually asked for. Everything the child prints already
   * passes through the caller, so this costs a scan and nothing else.
   */
  observeChildOutput(text: string): void;
  /** Restore the terminal and stop reading. Safe to call more than once. */
  close(): void;
}

export interface TerminalInputDeps {
  /** Where to write terminal-correcting sequences; defaults to stdout. */
  out?: (text: string) => void;
  /** Injected in tests. */
  gate?: MouseGate;
  /**
   * Told once when reports are being dropped that the session never asked for.
   *
   * Silence here would be a mistake repeated. This bug survived two fixes
   * partly because nothing recorded what was happening, so each attempt began
   * by guessing again. If it ever comes back, the log should already say that
   * the terminal was reporting mouse activity nobody requested, and whether
   * telling it to stop worked.
   */
  onUnrequestedReports?: (detail: { dropped: number; toldTerminalToStop: boolean }) => void;
}

type Stdin = NodeJS.ReadStream & {
  setRawMode?: (v: boolean) => void;
  unref?: () => void;
};

/** Claim the terminal for this run. */
export function openTerminalInput(
  stream: NodeJS.ReadStream = process.stdin,
  deps: TerminalInputDeps = {},
): TerminalInput {
  const stdin = stream as Stdin;
  const out = deps.out ?? ((text: string) => void process.stdout.write(text));
  const gate = deps.gate ?? createMouseGate();
  let target: Writer | null = null;
  let closed = false;
  let correctedTerminal = false;

  // Normalize Enter: terminals may send \r\n or a lone \n, but the TUI submits
  // on \r. Without this, typing works but Enter never sends (MinTTY).
  const forEnter = (text: string): string => text.replace(/\r?\n/g, '\r');

  // Escape sequences are reassembled before being forwarded. A chunk boundary in
  // the middle of one used to deliver its halves as two separate writes, and the
  // reader then showed the tail as typed text: mouse reports turning up in the
  // prompt as "35;112;43M" with their ESC[< prefix gone.
  const buffer = createEscapeBuffer((held) => send(held));

  /**
   * Everything the operator types reaches the child through here, and nothing
   * else does. So this is the one place that can guarantee a report the child
   * never asked for cannot reach it.
   */
  const send = (text: string): void => {
    const { forward, dropped, unrequestedMotion } = gate.filterInput(text);
    if (unrequestedMotion && !correctedTerminal) {
      // Dropping the reports keeps them off the screen; this stops them being
      // sent at all, which is the difference between hiding the symptom and
      // ending it. Once per run: the terminal either listens or it does not.
      correctedTerminal = true;
      let told = true;
      try {
        out(STOP_UNREQUESTED_MOTION);
      } catch {
        // A terminal that will not take it is no reason to fail a keystroke,
        // and the gate keeps working regardless; the report says which it was.
        told = false;
      }
      deps.onUnrequestedReports?.({ dropped, toldTerminalToStop: told });
    }
    if (forward) target?.(forEnter(forward));
  };

  const onData = (d: Buffer): void => {
    const ready = buffer.push(d.toString('utf8'));
    if (ready) send(ready);
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
        // Cleared when the OLD reader lets go, never when a new one arrives.
        // A child writes its mode declarations the instant it starts, and the
        // relay is watching its output before it is attached to, so resetting
        // on attach would wipe what the new child had already said and leave
        // ccx dropping reports it genuinely asked for. Ending the previous
        // session is the moment nothing is owed to anybody.
        buffer.reset();
        gate.childChanged();
      };
    },
    observeChildOutput(text: string) {
      gate.observeOutput(text);
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
