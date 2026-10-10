import { describe, it, expect } from 'vitest';
import { createKeyboardWatch } from './keyboard-watch.js';

const ESC = '\x1b';

/** The watch after it has seen each chunk, a millisecond apart from 1000. */
function after(...chunks: string[]): { lastKeyAt: number; endedOnEnter: boolean } {
  const watch = createKeyboardWatch();
  chunks.forEach((chunk, i) => watch.saw(chunk, 1000 + i));
  return { lastKeyAt: watch.lastKeyAt(), endedOnEnter: watch.endedOnEnter() };
}

describe('what the person at the keyboard has done', () => {
  it('has seen nothing before anything is typed', () => {
    expect(after()).toEqual({ lastKeyAt: 0, endedOnEnter: false });
  });

  it('counts typing, and says when the last key was Enter', () => {
    expect(after('fix the te')).toEqual({ lastKeyAt: 1000, endedOnEnter: false });
    expect(after('fix the test\r')).toEqual({ lastKeyAt: 1000, endedOnEnter: true });
    expect(after('fix', ' it', '\r')).toEqual({ lastKeyAt: 1002, endedOnEnter: true });
    // Typed on after the Enter: a new draft.
    expect(after('fix it\r', 'and th')).toEqual({ lastKeyAt: 1001, endedOnEnter: false });
  });

  it('does not take an Enter that starts a new line for one that sends', () => {
    // Backslash then Enter, and Escape then Enter, both add a line in Claude.
    expect(after('first line\\\r').endedOnEnter).toBe(false);
    expect(after('first line\\', '\r').endedOnEnter).toBe(false);
    expect(after(`first line${ESC}\r`).endedOnEnter).toBe(false);
    // Shift+Enter as a terminal with the newer key reporting sends it.
    expect(after(`first line${ESC}[13;2u`).endedOnEnter).toBe(false);
  });

  it('counts the keys that are not characters', () => {
    for (const key of [
      ESC, // Escape
      `${ESC}[A`, // up: recalls an earlier prompt into the box
      `${ESC}OA`, // up, as some terminals send it
      `${ESC}[3~`, // Delete
      `${ESC}[Z`, // Shift+Tab
      `${ESC}b`, // Alt+b
      '\x03', // Ctrl+C
      '\x7f', // Backspace
      `${ESC}[97;5u`, // Ctrl+a under the newer key reporting
    ]) {
      expect(after('\r', key), JSON.stringify(key)).toEqual({
        lastKeyAt: 1001,
        endedOnEnter: false,
      });
    }
  });

  it('counts a paste as typing, wherever its text is cut', () => {
    expect(after(`${ESC}[200~some pasted text${ESC}[201~`)).toEqual({
      lastKeyAt: 1000,
      endedOnEnter: false,
    });
    // A report-shaped run of bytes inside a paste is still pasted text.
    expect(after('\r', `${ESC}[200~first half `, `${ESC}[I second half${ESC}[201~`).lastKeyAt).toBe(
      1002,
    );
    // And after the paste ends, reports are reports again.
    expect(after(`${ESC}[200~x${ESC}[201~`, `${ESC}[I`).lastKeyAt).toBe(1000);
  });

  it('does not count what the terminal sends by itself', () => {
    for (const report of [
      `${ESC}[I`, // the window gained focus
      `${ESC}[O`, // and lost it
      `${ESC}[<0;10;20M`, // a mouse press
      `${ESC}[<0;10;20m`, // and its release
      `${ESC}[<35;99;8M`, // the mouse moving
      `${ESC}[M !!`, // a press in the original encoding
      `${ESC}[12;40R`, // where the cursor is
      `${ESC}[?62;22c`, // what kind of terminal this is
      `${ESC}[>0;276;0c`,
      `${ESC}[?2026;2$y`, // whether a mode is set
      `${ESC}[?1u`, // which key reporting is on
      `${ESC}[8;40;120t`, // the window's size
      `${ESC}[?997;1n`, // dark or light
      `${ESC}]11;rgb:0000/0000/0000${ESC}\\`, // the background colour
      `${ESC}]11;rgb:0000/0000/0000\x07`,
      `${ESC}P>|xterm(380)${ESC}\\`, // the terminal's name
      `${ESC}_Gi=1;OK${ESC}\\`,
    ]) {
      expect(after('\r', report), JSON.stringify(report)).toEqual({
        lastKeyAt: 1000,
        endedOnEnter: true,
      });
    }
    // Several at once, as a window regaining focus sends them.
    expect(after(`${ESC}[I${ESC}[?997;1n${ESC}]11;rgb:0/0/0\x07`).lastKeyAt).toBe(0);
  });

  it('counts a key that arrives beside a report', () => {
    expect(after(`${ESC}[Ix`)).toEqual({ lastKeyAt: 1000, endedOnEnter: false });
    expect(after(`go\r${ESC}[O`)).toEqual({ lastKeyAt: 1000, endedOnEnter: true });
  });

  it('counts anything it cannot place as a key', () => {
    // Unknown is treated as the person, which errs toward not typing over them.
    expect(after(`${ESC}[5;5;5x`).lastKeyAt).toBe(1000);
    expect(after(`${ESC}[`).lastKeyAt).toBe(1000);
  });
});
