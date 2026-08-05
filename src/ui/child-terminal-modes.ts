/**
 * Putting back the terminal modes a child left switched on.
 *
 * Claude's interface turns on mouse tracking and bracketed paste when it starts,
 * and turns them off again when it exits normally. Measured against the real
 * binary, it sets all five of these:
 *
 *   ?1000h click tracking      ?1002h drag tracking
 *   ?1003h ANY-MOTION tracking ?1006h SGR encoding
 *   ?2004h bracketed paste
 *
 * ccx ends a session by killing it, on every rotation, every account switch and
 * the no-conversation retry. A kill skips the child's exit handler, so none of
 * those get turned off, and the terminal carries on reporting. With ?1003h still
 * set, EVERY mouse movement sends a report; with ?1006h it is sent in the SGR
 * form, and once nothing is prepared to read them they land wherever input goes
 * next as literal text:
 *
 *   ;171;15M5;111;6M
 *
 * which is a cursor position, not a random character. That is what has been
 * appearing in the operator's input box.
 *
 * So ccx puts them back itself. It cannot ask a process it just killed to do it,
 * and it must not assume the next session will: the reports are generated in the
 * gap, before anything is listening. Sending a mode off that is already off does
 * nothing, so this is safe to send on every exit rather than only after a kill,
 * which also covers a child that crashed.
 */

/** Cursor restored too: a killed interface can leave it hidden. */
export const CHILD_MODES_OFF =
  '\x1b[?1000l' + '\x1b[?1002l' + '\x1b[?1003l' + '\x1b[?1006l' + '\x1b[?2004l' + '\x1b[?25h';

/**
 * Write the reset, never throwing.
 *
 * Called while a session is ending, which is exactly when the far end of the
 * terminal may already be gone. Failing to tidy up is not a reason to take the
 * run down with it.
 */
export function resetChildTerminalModes(
  write: (text: string) => unknown = (text) => process.stdout.write(text),
): boolean {
  try {
    write(CHILD_MODES_OFF);
    return true;
  } catch {
    return false;
  }
}
