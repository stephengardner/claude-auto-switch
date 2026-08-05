/**
 * A terminal that goes away must never end the program.
 *
 * Stream errors arrive ASYNCHRONOUSLY, as an 'error' event rather than a throw,
 * so a try/catch around a read or a write cannot see them. With no listener,
 * Node re-throws them as an uncaught exception and the process dies.
 *
 * That is not hypothetical here. Pressing "l" in the dashboard hands the screen
 * back and then prints the sign-in's progress, and the handoff swaps the screen
 * and pauses input at the same moment. Both directions were seen failing about
 * 60ms after the keypress, killing the dashboard with nothing on screen to say
 * why: `write EPIPE` from the progress line, and `read EPIPE` from stdin. From
 * the outside it looked like signing in had crashed the terminal.
 *
 * EPIPE and a destroyed stream both mean the same thing: the other end has
 * gone. There is nowhere left to report that, and it is not a reason to abandon
 * the work in progress, so it is dropped. Anything else is a real fault and is
 * left alone to be noticed.
 */

const GONE = new Set(['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);

export function isTerminalGone(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && GONE.has(code);
}

interface ErrorEmitter {
  on: (event: string, listener: (err: unknown) => void) => unknown;
}

/**
 * Called once at startup, for BOTH directions: a dead pipe is as fatal when
 * reading keys as when printing a line.
 *
 * Returns how many streams it attached to, so a test can check the wiring
 * rather than reaching for the global streams.
 */
export function tolerateBrokenTerminal(
  streams: Array<ErrorEmitter | undefined> = [process.stdout, process.stderr, process.stdin],
): number {
  let attached = 0;
  for (const stream of streams) {
    if (typeof stream?.on !== 'function') continue;
    stream.on('error', (err: unknown) => {
      if (isTerminalGone(err)) return;
      throw err;
    });
    attached++;
  }
  return attached;
}
