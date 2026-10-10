/**
 * What the person at the keyboard has done to Claude's input box, as far as
 * the keys they pressed can say.
 *
 * ccx relays every keystroke to Claude, so it sees each one. That is what lets
 * it type a prompt into a live session without typing into the middle of
 * theirs: it knows when they last pressed a key, and whether the last thing
 * they pressed was the Enter that sends a prompt.
 *
 * A terminal also sends things nobody pressed: that the window gained or lost
 * focus, where the mouse is, its answers to what Claude asked it (its size,
 * its colours, where the cursor is). Those are told apart here, because a
 * window regaining focus must not read as somebody typing. Anything that
 * cannot be placed counts as a key: wrongly believing the person typed only
 * stops ccx typing, and wrongly believing they did not could type over them.
 */

const ESC = '\x1b';
const BEL = '\x07';
/** String Terminator: Escape followed by a backslash. */
const ST = `${ESC}\\`;
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
/** Introducers of strings only a terminal sends: OSC, DCS, SOS, PM and APC. */
const STRING_KINDS = new Set([']', 'P', 'X', '^', '_']);

export interface KeyboardWatch {
  /** Note what is being relayed to Claude, at time `now`. */
  saw(text: string, now: number): void;
  /** When the person last pressed a key or pasted; 0 when they never have. */
  lastKeyAt(): number;
  /**
   * Whether the last key they pressed was a plain Enter, the one that sends
   * what is in the box. Enter after a backslash or an Escape starts a new line
   * in Claude instead, so neither counts.
   */
  endedOnEnter(): boolean;
}

/**
 * Whether one control sequence (`ESC [ params intermediates final`) is the
 * terminal reporting something, rather than a key. Named by what they report.
 */
function isReport(params: string, intermediates: string, final: string): boolean {
  const prefix = params[0] ?? '';
  switch (final) {
    case 'I': // focus gained
    case 'O': // focus lost
      return params === '' && intermediates === '';
    case 'M': // mouse
    case 'm':
      return params !== '';
    case 'R': // cursor position
      return /^\??[0-9]+;[0-9]+$/.test(params);
    case 'c': // device attributes
      return prefix === '?' || prefix === '>' || prefix === '=';
    case 'y': // whether a mode is set
      return intermediates === '$';
    case 'u': // which key reporting is on; without the "?" it is a key
    case 'n': // device status, dark or light among them
    case 'S': // graphics attributes
      return prefix === '?';
    case 't': // window size
      return /^[0-9;]+$/.test(params);
    default:
      return false;
  }
}

export function createKeyboardWatch(): KeyboardWatch {
  let lastKeyAt = 0;
  let endedOnEnter = false;
  /** Inside a paste that has not ended yet: everything is pasted text. */
  let pasting = false;
  /** The key before this one was a backslash, so an Enter now adds a line. */
  let afterBackslash = false;

  return {
    saw(text, now) {
      let keyed = false;
      const key = (kind: 'enter' | 'backslash' | 'other'): void => {
        keyed = true;
        endedOnEnter = kind === 'enter' && !afterBackslash;
        afterBackslash = kind === 'backslash';
      };
      let i = 0;
      while (i < text.length) {
        if (pasting) {
          key('other');
          const end = text.indexOf(PASTE_END, i);
          if (end === -1) break;
          pasting = false;
          i = end + PASTE_END.length;
          continue;
        }
        const ch = text[i] as string;
        if (ch !== ESC) {
          key(ch === '\r' ? 'enter' : ch === '\\' ? 'backslash' : 'other');
          i += 1;
          continue;
        }
        const kind = text[i + 1];
        if (kind === undefined) {
          key('other'); // the Escape key
          i += 1;
        } else if (kind === '[') {
          if (text.startsWith(PASTE_START, i)) {
            pasting = true;
            key('other');
            i += PASTE_START.length;
          } else if (text[i + 2] === 'M') {
            i += 6; // the original mouse report: three bytes follow
          } else {
            let j = i + 2;
            while (j < text.length && text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x3f)
              j += 1;
            const params = text.slice(i + 2, j);
            const from = j;
            while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f)
              j += 1;
            const final = text[j];
            if (final === undefined || !isReport(params, text.slice(from, j), final)) key('other');
            i = j + 1;
          }
        } else if (STRING_KINDS.has(kind)) {
          const st = text.indexOf(ST, i + 2);
          const bel = kind === ']' ? text.indexOf(BEL, i + 2) : -1;
          const ends = [st === -1 ? -1 : st + ST.length, bel === -1 ? -1 : bel + 1].filter(
            (at) => at !== -1,
          );
          i = ends.length > 0 ? Math.min(...ends) : text.length;
        } else if (kind === 'O') {
          key('other'); // an arrow or function key, as some terminals send them
          i += 3;
        } else {
          key('other'); // Alt with a key, or Escape then Enter
          i += 2;
        }
      }
      if (keyed) lastKeyAt = now;
    },
    lastKeyAt: () => lastKeyAt,
    endedOnEnter: () => endedOnEnter,
  };
}
