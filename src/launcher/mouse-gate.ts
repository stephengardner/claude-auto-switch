/**
 * Only pass on the mouse reports the program actually asked for.
 *
 * A terminal sends mouse reports because some program switched a tracking mode
 * on. The mode belongs to the TERMINAL, not to the program: it survives that
 * program exiting, being killed, or crashing. So the next program inherits a
 * terminal that reports mouse activity it never requested, cannot parse, and
 * therefore shows as typed text.
 *
 * Measured against the shipped Claude binary, it enables exactly two mouse
 * modes: `?1000h` (click) and `?1006h` (SGR encoding). It never asks for
 * `?1002h` (drag) or `?1003h` (any-motion). Yet the reports arriving in the
 * operator's input box were `<35;99;8M`: button code 35 is 32 (motion) plus 3
 * (no button), which ONLY any-motion tracking produces. Something else had
 * left `?1003h` on, and every mouse movement across the window was being sent
 * to a program that had asked for clicks.
 *
 * That is not a race to be timed better, and no amount of tidying up on exit
 * fixes it: the mode can be set by anything, at any time, including before ccx
 * ever ran. The reliable answer is to stop trusting the terminal's state and
 * start tracking what the CHILD asked for, which ccx can see because every byte
 * the child writes passes through it. A report the child cannot have asked for
 * is dropped, and the terminal is told to stop sending them.
 */

const ESC = '\x1b';

/** The mouse tracking a program has switched on. */
export interface MouseModes {
  /** ?1000: press and release. */
  click: boolean;
  /** ?1002: motion while a button is held. */
  drag: boolean;
  /** ?1003: motion at all times, the noisy one. */
  motion: boolean;
}

export const NO_MOUSE: MouseModes = { click: false, drag: false, motion: false };

/** Every `ESC [ ? <params> h|l` in some output, as (mode, enabled) pairs. */
function privateModeChanges(text: string): Array<{ mode: number; on: boolean }> {
  const out: Array<{ mode: number; on: boolean }> = [];
  // Params may be combined ("?1000;1006h"), which is why this cannot be a
  // lookup for whole strings: a combined enable would be missed entirely.
  const pattern = /\x1b\[\?([0-9;]+)([hl])/g;
  for (const match of text.matchAll(pattern)) {
    const on = match[2] === 'h';
    for (const part of (match[1] ?? '').split(';')) {
      const mode = Number(part);
      if (Number.isFinite(mode) && part.length > 0) out.push({ mode, on });
    }
  }
  return out;
}

/** Apply what a program just wrote to what we believe it has asked for. */
export function applyModeChanges(current: MouseModes, output: string): MouseModes {
  let next = current;
  for (const { mode, on } of privateModeChanges(output)) {
    if (mode === 1000) next = { ...next, click: on };
    else if (mode === 1002) next = { ...next, drag: on };
    else if (mode === 1003) next = { ...next, motion: on };
  }
  return next;
}

/** A mouse report found in the input stream. */
interface Report {
  start: number;
  end: number;
  /** True when the report describes movement rather than a press or release. */
  motion: boolean;
}

/**
 * Find one mouse report at `at`, or null.
 *
 * Both encodings are recognised. SGR (`ESC [ < b ; x ; y M|m`) is what modern
 * terminals send once `?1006h` is on; the original X10 form (`ESC [ M` plus
 * three bytes) is what they send otherwise, and a program that never enabled
 * SGR can still be sent those.
 */
function reportAt(text: string, at: number): Report | null {
  if (!text.startsWith(`${ESC}[`, at)) return null;

  // SGR: ESC [ < params M or m
  if (text[at + 2] === '<') {
    let i = at + 3;
    while (i < text.length && /[0-9;]/.test(text[i] as string)) i += 1;
    const final = text[i];
    if (final !== 'M' && final !== 'm') return null;
    const button = Number((text.slice(at + 3, i).split(';')[0] ?? '').trim());
    // Bit 5 (32) marks movement. Bit 6 (64) marks the wheel, which reports with
    // bit 5 clear, so no special case is needed for it.
    return { start: at, end: i + 1, motion: Number.isFinite(button) && (button & 32) !== 0 };
  }

  // X10: ESC [ M then exactly three bytes (button, column, row).
  if (text[at + 2] === 'M') {
    if (text.length < at + 6) return null; // incomplete; the buffer holds it
    const button = (text.charCodeAt(at + 3) - 32) & 0xff;
    return { start: at, end: at + 6, motion: (button & 32) !== 0 };
  }

  return null;
}

export interface FilterResult {
  /** What may be forwarded to the child. */
  forward: string;
  /** How many reports were dropped. */
  dropped: number;
  /**
   * True when a MOTION report arrived that the child never asked for, so the
   * caller can tell the terminal to stop sending them.
   */
  unrequestedMotion: boolean;
}

/**
 * Remove the mouse reports this program cannot have asked for.
 *
 * The rule is narrow on purpose. Reports are only ever dropped when the child's
 * own declared modes say it could not have wanted them:
 *
 *   nothing enabled          drop every report
 *   click only (?1000)       drop MOTION reports, keep presses and releases
 *   drag or motion enabled   keep everything
 *
 * Anything that is not a mouse report is passed through untouched, so ordinary
 * typing, arrow keys, pastes and Escape are unaffected.
 */
export function filterMouseReports(text: string, modes: MouseModes): FilterResult {
  // The common case by far: nothing to do, and worth not scanning for.
  if (!text.includes(`${ESC}[`)) {
    return { forward: text, dropped: 0, unrequestedMotion: false };
  }

  const wantsMotion = modes.drag || modes.motion;
  const wantsAny = modes.click || wantsMotion;

  let forward = '';
  let dropped = 0;
  let unrequestedMotion = false;
  let i = 0;
  while (i < text.length) {
    const report = reportAt(text, i);
    if (!report) {
      forward += text[i];
      i += 1;
      continue;
    }
    const allowed = report.motion ? wantsMotion : wantsAny;
    if (allowed) {
      forward += text.slice(report.start, report.end);
    } else {
      dropped += 1;
      if (report.motion) unrequestedMotion = true;
    }
    i = report.end;
  }

  return { forward, dropped, unrequestedMotion };
}

/** Turn off the tracking nobody asked for. Safe to send to any terminal. */
export const STOP_UNREQUESTED_MOTION = `${ESC}[?1003l${ESC}[?1002l`;

export interface MouseGate {
  /** Note what the child just wrote, so we know what it has asked for. */
  observeOutput(text: string): void;
  /** Filter operator input before it reaches the child. */
  filterInput(text: string): FilterResult;
  /** Forget the child's modes; the next child starts from nothing. */
  childChanged(): void;
  /** What the child currently has enabled, for tests and diagnostics. */
  modes(): MouseModes;
}

export function createMouseGate(): MouseGate {
  let modes: MouseModes = NO_MOUSE;
  return {
    observeOutput: (text) => {
      modes = applyModeChanges(modes, text);
    },
    filterInput: (text) => filterMouseReports(text, modes),
    childChanged: () => {
      // A new child has asked for nothing yet. Assuming otherwise would carry
      // the previous one's modes into a program that never set them, which is
      // the inheritance this whole file exists to break.
      modes = NO_MOUSE;
    },
    modes: () => modes,
  };
}
