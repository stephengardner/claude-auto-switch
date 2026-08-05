import { describe, it, expect } from 'vitest';
import { resetChildTerminalModes, CHILD_MODES_OFF } from './child-terminal-modes.js';

describe('resetChildTerminalModes', () => {
  it('turns off every mode Claude was measured turning on', () => {
    // Measured against the real binary: it sets all five of these on start and
    // clears them on a normal exit. We kill it instead, so we clear them.
    for (const mode of ['?1000l', '?1002l', '?1003l', '?1006l', '?2004l']) {
      expect(CHILD_MODES_OFF).toContain(`\x1b[${mode}`);
    }
  });

  it('turns ANY-MOTION tracking and SGR encoding off specifically', () => {
    // These two are the pair that produced ";171;15M" in the input box: 1003
    // reports every mouse MOVE, and 1006 is the encoding that shape comes from.
    // A reset that missed either would leave the reported symptom in place.
    expect(CHILD_MODES_OFF).toContain('\x1b[?1003l');
    expect(CHILD_MODES_OFF).toContain('\x1b[?1006l');
  });

  it('shows the cursor again, since a killed interface can leave it hidden', () => {
    expect(CHILD_MODES_OFF).toContain('\x1b[?25h');
  });

  it('never turns a REPORTING mode back on', () => {
    // A stray "h" on any of these would switch on the very reporting this
    // exists to stop. The cursor is deliberately an exception: ?25h is how it
    // is shown again, so this asks the precise question rather than banning
    // every "h" and reading a correct line as a fault.
    expect(CHILD_MODES_OFF).not.toMatch(/\x1b\[\?(?:1000|1002|1003|1006|1015|2004)h/);
  });

  it('writes the reset', () => {
    const written: string[] = [];
    expect(resetChildTerminalModes((t) => written.push(t))).toBe(true);
    expect(written.join('')).toBe(CHILD_MODES_OFF);
  });

  it('does not throw when the terminal has already gone', () => {
    // It runs while a session is ending, which is exactly when the far end can
    // be gone. Failing to tidy up must not take the run down.
    expect(
      resetChildTerminalModes(() => {
        const err = new Error('EPIPE') as NodeJS.ErrnoException;
        err.code = 'EPIPE';
        throw err;
      }),
    ).toBe(false);
  });
});
