/**
 * Putting back the terminal modes a child may have left switched on.
 *
 * Corrected after two failed attempts at the stray-characters bug, both of
 * which were built on a claim in THIS comment that turned out to be false. It
 * used to say Claude sets ?1000h, ?1002h, ?1003h, ?1006h and ?2004h, "measured
 * against the real binary". It does not. The shipped binary's entire private
 * mode vocabulary is:
 *
 *   ?1049 alternate screen   ?9001 win32 input   ?1004 focus reporting
 *   ?2026 synchronised output ?1007 alternate scroll
 *   ?1006 SGR mouse encoding  ?1000 click tracking
 *
 * There is no ?1002, no ?1003 and no ?2004 anywhere in it. So "a killed child
 * left motion tracking on" was never what was happening, and every fix aimed at
 * that premise missed. The reports that actually reached the operator's input
 * box carried button 35, which is motion, and nothing Claude enables can
 * produce those: the mode belonged to the TERMINAL, set by something else,
 * possibly long before ccx ran.
 *
 * That is why the real defence lives in launcher/mouse-gate.ts, which drops
 * reports a child cannot have asked for whatever the terminal is doing. This
 * reset stays because it is still worth leaving a terminal tidy: a kill skips
 * the child's own cleanup, so ?1000h and ?1006h really can be left on, and
 * sending an off for a mode that is already off does nothing. It is a courtesy,
 * not the fix, and describing it as the fix cost two attempts.
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
