import { resetChildTerminalModes } from './child-terminal-modes.js';

/**
 * The one owner of what ccx itself puts on the operator's terminal.
 *
 * ccx and Claude share one terminal, and the bugs in this area were all
 * ownership bugs: a message painted into a screen Claude was drawing, a mode
 * reset written before the dead child's last flush (which then re-enabled the
 * very modes the reset turned off), a crash that left mouse tracking on so the
 * shell prompt filled with `;171;15M` reports. Each was patched where it was
 * seen, in a different file, holding its own flag.
 *
 * This service replaces those scattered flags with one piece of state and three
 * rules:
 *
 * - While a child owns the screen, a line is HELD, and only the last one is
 *   kept: these are endings, and an ending replaces the one before it. It is
 *   said the moment the screen comes back.
 * - When the run is over, the child's terminal modes are put back and anything
 *   held is said. This runs AFTER the last session's trailing output has
 *   settled, so nothing can re-enable the modes behind its back.
 * - If the process dies instead of ending cleanly, a crash guard puts the modes
 *   back on the way out. A killed wrapper must not leave the operator's shell
 *   receiving mouse reports as typed text.
 */

export interface TerminalWriterDeps {
  /** Where a line goes; defaults to stderr with a newline. */
  line?: (text: string) => void;
  /** Puts the child's terminal modes back; defaults to the real sequences. */
  resetModes?: () => void;
  /** Registers the crash guard; defaults to process.on('exit'). */
  onProcessExit?: (fn: () => void) => void;
}

export interface TerminalWriter {
  /** Claude has the terminal from here. */
  childStarted(): void;
  /**
   * The child is gone AND its trailing output has settled (the PTY layer waits
   * that window out before it resolves). Flushes whatever was held.
   */
  childEnded(): void;
  /** True while a child owns the screen. */
  ownsScreen(): boolean;
  /** Say a line now, or hold it (last one wins) until the screen is free. */
  say(text: string): void;
  /** What is waiting, for tests and for a caller that wants to check. */
  held(): string | null;
  /**
   * The whole run is over: put the child's modes back one final time and say
   * anything still held. The per-session reset already ran, but a flush that
   * arrived after it can have switched modes back on, and this is the last
   * moment to correct that before the shell gets the terminal.
   */
  runEnding(): void;
}

export function createTerminalWriter(deps: TerminalWriterDeps = {}): TerminalWriter {
  const line = deps.line ?? ((text: string) => process.stderr.write(`${text}\n`));
  const resetModes = deps.resetModes ?? (() => resetChildTerminalModes());
  const onProcessExit = deps.onProcessExit ?? ((fn: () => void) => process.on('exit', fn));

  let childOwns = false;
  let pending: string | null = null;
  /**
   * True from the first child until the run's final reset. The crash guard
   * fires on this, not on childOwns: a crash BETWEEN sessions still leaves the
   * modes wherever the last child put them.
   */
  let modesDirty = false;
  let guardInstalled = false;
  let guardSpent = false;

  const flush = (): void => {
    if (pending === null) return;
    const message = pending;
    pending = null;
    line(message);
  };

  const putModesBack = (): void => {
    try {
      resetModes();
    } catch {
      /* a terminal that rejects the reset is not worth crashing over */
    }
    modesDirty = false;
  };

  return {
    childStarted: () => {
      childOwns = true;
      modesDirty = true;
      if (!guardInstalled) {
        guardInstalled = true;
        onProcessExit(() => {
          // Once, and only when something is actually dirty: a clean run has
          // already reset, and a double reset from an exit handler would write
          // into whatever the shell is doing now.
          if (guardSpent || !modesDirty) return;
          guardSpent = true;
          putModesBack();
        });
      }
    },
    childEnded: () => {
      childOwns = false;
      flush();
    },
    ownsScreen: () => childOwns,
    say: (text) => {
      if (childOwns) {
        pending = text;
        return;
      }
      line(text);
    },
    held: () => pending,
    runEnding: () => {
      childOwns = false;
      if (modesDirty) putModesBack();
      flush();
    },
  };
}
