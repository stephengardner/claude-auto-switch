import { describe, it, expect } from 'vitest';
import { screenSequences } from './dashboard.js';

/**
 * The dashboard draws a full-screen live view. Everywhere but Windows it does so
 * on the alternate screen buffer, which restores the prior scrollback on exit.
 * On Windows it must NOT, because leaving the alternate screen (`?1049l`) is a
 * buffer swap that, landing as the process exits or hands off to a sign-in,
 * races ConPTY's teardown and crashes the terminal. These pin that split so it
 * cannot silently regress.
 */

const ENTER_ALT = '\x1b[?1049h';
const EXIT_ALT = '\x1b[?1049l';

describe('screenSequences', () => {
  it('uses the alternate screen off Windows, and leaves it on exit', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const seq = screenSequences(platform);
      expect(seq.usesAltScreen).toBe(true);
      expect(seq.enter).toContain(ENTER_ALT);
      expect(seq.epilogue).toContain(EXIT_ALT);
    }
  });

  it('never touches the alternate screen on Windows', () => {
    const seq = screenSequences('win32');
    expect(seq.usesAltScreen).toBe(false);
    // The crash is the enter/leave of the alternate buffer; neither sequence may
    // contain it on Windows.
    expect(seq.enter).not.toContain(ENTER_ALT);
    expect(seq.enter).not.toContain(EXIT_ALT);
    expect(seq.epilogue).not.toContain(EXIT_ALT);
    expect(seq.epilogue).not.toContain('\x1b[?1049');
  });

  it('still shows the cursor again on exit, on every platform', () => {
    const SHOW_CURSOR = '\x1b[?25h';
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(screenSequences(platform).epilogue).toContain(SHOW_CURSOR);
    }
  });

  it('starts the Windows dashboard on a cleared main screen', () => {
    // No alternate buffer to give a blank canvas, so the first frame clears the
    // screen and homes the cursor itself.
    const seq = screenSequences('win32');
    expect(seq.enter).toContain('\x1b[2J');
    expect(seq.enter).toContain('\x1b[H');
  });
});
