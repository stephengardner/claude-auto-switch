import { describe, it, expect } from 'vitest';
import {
  createMouseGate,
  filterMouseReports,
  applyModeChanges,
  NO_MOUSE,
  STOP_UNREQUESTED_MOTION,
} from './mouse-gate.js';

const ESC = '\x1b';
/** A movement report: button 35 is 32 (motion) plus 3 (no button held). */
const motion = (x: number, y: number) => `${ESC}[<35;${x};${y}M`;
/** A press, which click tracking really does ask for. */
const press = (x: number, y: number) => `${ESC}[<0;${x};${y}M`;
const release = (x: number, y: number) => `${ESC}[<0;${x};${y}m`;

describe('what a program has asked the terminal for', () => {
  it('reads the modes Claude actually enables', () => {
    // Measured against the shipped binary: click plus SGR encoding, and
    // nothing else. It never asks for motion, which is why motion reports
    // arriving in its input box were somebody else's doing.
    const modes = applyModeChanges(NO_MOUSE, `${ESC}[?1000h${ESC}[?1006h`);
    expect(modes).toEqual({ click: true, drag: false, motion: false });
  });

  it('reads modes that arrive COMBINED in one sequence', () => {
    // "?1000;1006h" is one write, and matching whole strings would miss it
    // entirely, leaving ccx believing the child asked for nothing.
    expect(applyModeChanges(NO_MOUSE, `${ESC}[?1000;1002;1003;1006h`)).toEqual({
      click: true,
      drag: true,
      motion: true,
    });
  });

  it('notices a program turning tracking back off', () => {
    const on = applyModeChanges(NO_MOUSE, `${ESC}[?1003h`);
    expect(applyModeChanges(on, `${ESC}[?1003l`).motion).toBe(false);
  });

  it('ignores private modes that have nothing to do with the mouse', () => {
    const modes = applyModeChanges(NO_MOUSE, `${ESC}[?1049h${ESC}[?2004h${ESC}[?25l`);
    expect(modes).toEqual(NO_MOUSE);
  });
});

describe('a declaration that arrives in pieces', () => {
  it('is still seen when it straddles two chunks of output', () => {
    // The child's output arrives in whatever chunks the pseudo-terminal makes,
    // and scanning each on its own would miss this. Missing an ENABLE is the
    // expensive direction: ccx would drop reports the child really did ask
    // for, breaking mouse support in the name of fixing a mouse bug.
    const gate = createMouseGate();
    gate.observeOutput(`${ESC}[?100`);
    gate.observeOutput('3h');
    expect(gate.modes().motion).toBe(true);
    expect(gate.filterInput(motion(1, 2)).forward).toBe(motion(1, 2));
  });

  it('is still seen when it is split byte by byte', () => {
    const gate = createMouseGate();
    for (const ch of `${ESC}[?1003h`) gate.observeOutput(ch);
    expect(gate.modes().motion).toBe(true);
  });

  it('counts a declaration once, however the chunks fall', () => {
    // The carried tail must never re-apply something already applied, or an
    // enable followed by a disable could be resurrected.
    const gate = createMouseGate();
    gate.observeOutput(`${ESC}[?1003`);
    gate.observeOutput(`h${ESC}[?1003l`);
    expect(gate.modes().motion).toBe(false);
  });

  it('does not hoard output that merely looks like the start of one', () => {
    const gate = createMouseGate();
    gate.observeOutput(`${ESC}[?${'x'.repeat(500)}`);
    gate.observeOutput(`${ESC}[?1003h`);
    expect(gate.modes().motion).toBe(true);
  });
});

describe('reports the program never asked for', () => {
  it('drops every report when nothing is enabled', () => {
    const result = filterMouseReports(`${motion(99, 8)}${press(10, 4)}`, NO_MOUSE);
    expect(result.forward).toBe('');
    expect(result.dropped).toBe(2);
  });

  it('drops MOTION for a program that only asked for clicks', () => {
    // The operator's exact case: Claude enables ?1000h, something else had
    // left ?1003h on, and every mouse movement was delivered to a program
    // that could not parse it.
    const modes = applyModeChanges(NO_MOUSE, `${ESC}[?1000h${ESC}[?1006h`);
    const result = filterMouseReports(`${motion(99, 8)}${press(10, 4)}${motion(100, 9)}`, modes);
    expect(result.forward).toBe(press(10, 4));
    expect(result.dropped).toBe(2);
    expect(result.unrequestedMotion).toBe(true);
  });

  it('keeps everything once motion tracking is genuinely enabled', () => {
    const modes = applyModeChanges(NO_MOUSE, `${ESC}[?1003h`);
    const stream = `${motion(1, 2)}${press(3, 4)}${release(3, 4)}`;
    expect(filterMouseReports(stream, modes).forward).toBe(stream);
  });

  it('keeps presses and releases for a click-only program', () => {
    const modes = applyModeChanges(NO_MOUSE, `${ESC}[?1000h`);
    const stream = `${press(3, 4)}${release(3, 4)}`;
    expect(filterMouseReports(stream, modes).forward).toBe(stream);
  });

  it('drops the OLD encoding too, which needs no ?1006 to arrive', () => {
    // X10 form: ESC [ M then three bytes. A program that never enabled SGR
    // still gets sent these, so recognising only SGR would leak them.
    const x10Motion = `${ESC}[M${String.fromCharCode(32 + 35, 32 + 10, 32 + 5)}`;
    const result = filterMouseReports(x10Motion, NO_MOUSE);
    expect(result.forward).toBe('');
    expect(result.dropped).toBe(1);
  });
});

describe('what must never be touched', () => {
  it('passes ordinary typing through unchanged', () => {
    const typed = 'ccx models fable opus\r';
    expect(filterMouseReports(typed, NO_MOUSE).forward).toBe(typed);
  });

  it('passes arrow keys, Escape and bracketed paste through unchanged', () => {
    const keys = `${ESC}[A${ESC}[B${ESC}${ESC}[200~pasted${ESC}[201~`;
    expect(filterMouseReports(keys, NO_MOUSE).forward).toBe(keys);
  });

  it('leaves text that merely LOOKS like a report alone', () => {
    // Typed characters, not a sequence: there is no Escape, so nothing here
    // is a report and every byte must survive.
    const typed = '<35;99;8M';
    expect(filterMouseReports(typed, NO_MOUSE).forward).toBe(typed);
  });

  it('keeps an unterminated sequence rather than eating the rest of the line', () => {
    // The escape buffer holds partial sequences; if one does reach here it
    // must not swallow everything after it.
    const partial = `${ESC}[<35;99`;
    expect(filterMouseReports(partial, NO_MOUSE).forward).toBe(partial);
  });
});

describe('the gate over a session', () => {
  it('starts closed, opens on what the child declares, and closes for the next child', () => {
    const gate = createMouseGate();
    expect(gate.filterInput(motion(1, 2)).forward).toBe('');

    gate.observeOutput(`${ESC}[?1003h`);
    expect(gate.filterInput(motion(1, 2)).forward).toBe(motion(1, 2));

    // An account swap starts a different program, which has asked for nothing.
    gate.childChanged();
    expect(gate.modes()).toEqual(NO_MOUSE);
    expect(gate.filterInput(motion(1, 2)).forward).toBe('');
  });

  it('reproduces the operator report: motion arriving at a click-only session', () => {
    // The bytes behind ";30M" and ";19m;24m" in the screenshots.
    const gate = createMouseGate();
    gate.observeOutput(`${ESC}[?1049h${ESC}[?1000h${ESC}[?1006h`);
    const flood = [motion(99, 8), motion(316, 17), motion(237, 16), motion(84, 3)].join('');
    const result = gate.filterInput(`hello${flood}world`);
    expect(result.forward).toBe('helloworld');
    expect(result.unrequestedMotion).toBe(true);
  });

  it('offers a sequence that turns the unrequested tracking off at the source', () => {
    expect(STOP_UNREQUESTED_MOTION).toBe(`${ESC}[?1003l${ESC}[?1002l`);
  });
});
