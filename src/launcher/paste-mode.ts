import { privateModeChanges, unfinishedModeTail } from './mouse-gate.js';

/**
 * Typing a prompt into a program as ONE marked paste.
 *
 * A program that asks for bracketed paste (`ESC [ ? 2004 h`) is told where a
 * paste starts and ends, so text between the markers is text and nothing else:
 * no character in it is a key. Claude asks for it, and written this way a
 * prompt lands in its input box whole, and the Enter after the closing marker
 * sends it (measured against 2.1.296: the prompt was recorded exactly as
 * written, and the turn started within 25 ms).
 *
 * Typed as bare characters instead, the same text would be read key by key by
 * whatever has the keyboard. So ccx types a prompt only into a program that
 * has asked for marked pastes, and this watches for that request in the
 * program's own output.
 */

const ESC = '\x1b';
const BRACKETED_PASTE = 2004;

export interface PasteModeWatch {
  /** Note what the program just wrote. */
  observe(output: string): void;
  /** Whether it has asked for pastes to be marked, and not taken that back. */
  on(): boolean;
}

export function createPasteModeWatch(): PasteModeWatch {
  let on = false;
  /** The end of the last output, when it could be the start of a mode request. */
  let carried = '';
  return {
    observe(output) {
      const whole = carried + output;
      for (const change of privateModeChanges(whole)) {
        if (change.mode === BRACKETED_PASTE) on = change.on;
      }
      carried = unfinishedModeTail(whole);
    },
    on: () => on,
  };
}

/**
 * `text` as a marked paste followed by Enter. Control characters become
 * spaces, so nothing in the text can close the paste early or act as a key.
 */
export function pasteAndSend(text: string): string {
  const plain = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  return `${ESC}[200~${plain}${ESC}[201~\r`;
}
