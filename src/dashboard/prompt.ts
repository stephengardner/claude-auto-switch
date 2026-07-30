/**
 * The one-line text box the dashboard uses to ask for a name.
 *
 * Pure on purpose, like the key dispatcher next to it: typing, deleting and
 * confirming are decided here, so the behaviour can be tested without a
 * terminal. The dashboard only draws the result.
 *
 * Everything works on a CHUNK rather than a single key, because that is what a
 * terminal delivers: typing at speed, or pasting, arrives as one blob holding
 * several keystrokes. Acting on only the first byte of a chunk is how a hand
 * rolled text box ends up impossible to confirm.
 */

export type PromptStatus = 'editing' | 'submit' | 'cancel';

/** What the box is being used for, which decides what submitting it does. */
export type PromptKind = 'add' | 'rename';

export interface PromptState {
  kind: PromptKind;
  /** The question shown to the operator. */
  label: string;
  text: string;
  status: PromptStatus;
  /** Set when the typed value is not usable, shown under the box. */
  error?: string;
}

export function openPrompt(kind: PromptKind, label: string, text = ''): PromptState {
  return { kind, label, text, status: 'editing' };
}

const BACKSPACE = 8;
const DELETE = 127;
const ESCAPE = 27;
const CARRIAGE_RETURN = 13;
const LINE_FEED = 10;
const CTRL_C = 3;
const CTRL_U = 21;
const SPACE = 32;

/**
 * Apply a chunk of keypresses.
 *
 * Enter confirms, Escape and Ctrl-C cancel, Ctrl-U clears the line, Backspace and
 * Delete remove a character. Everything is applied in the order it arrived, so a
 * chunk mixing editing and text behaves the same as typing it slowly. Control
 * bytes and escape sequences (arrow keys and the like) are skipped rather than
 * typed in as junk.
 */
export function promptKey(state: PromptState, key: string, byte0?: number): PromptState {
  if (state.status !== 'editing') return state;
  // A chunk that IS a bare Escape cancels. A chunk that merely STARTS with one is
  // an arrow or function key: it must neither cancel nor be typed.
  if (byte0 === ESCAPE && key.length === 1) return { ...state, status: 'cancel' };

  const chars = [...key];
  let text = state.text;
  let changed = false;

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] as string;
    const code = ch.codePointAt(0) ?? 0;

    if (code === CTRL_C) return { ...state, status: 'cancel' };
    if (code === CARRIAGE_RETURN || code === LINE_FEED) {
      // Confirms with what was typed before it, and drops the rest of the chunk,
      // which is what pressing Enter means.
      return { ...state, text, status: 'submit', ...clearError(state) };
    }
    if (code === ESCAPE) {
      // Skip the whole sequence, so an arrow key pressed mid-chunk does not leave
      // its bracket and letter behind inside the name.
      i = endOfEscapeSequence(chars, i);
      continue;
    }
    if (code === CTRL_U) {
      text = '';
      changed = true;
      continue;
    }
    if (code === BACKSPACE || code === DELETE) {
      text = text.slice(0, -1);
      changed = true;
      continue;
    }
    if (code >= SPACE) {
      text += ch;
      changed = true;
    }
    // Any other control byte is ignored.
  }

  if (!changed) return state;
  return { ...state, text, ...clearError(state) };
}

/**
 * Index of the last character of the escape sequence starting at `start`.
 *
 * Terminal sequences end at a letter or a tilde (`\x1b[A`, `\x1b[1;2C`, `\x1b[3~`),
 * so the scan stops there. One that never terminates consumes the rest of the
 * chunk, which is the safe reading: better to drop it than to type it in.
 */
function endOfEscapeSequence(chars: string[], start: number): number {
  for (let i = start + 1; i < chars.length; i += 1) {
    if (/[A-Za-z~]/.test(chars[i] as string)) return i;
  }
  return chars.length;
}

/** Typing again clears a complaint about the previous value. */
function clearError(state: PromptState): { error?: undefined } {
  return state.error ? { error: undefined } : {};
}

/** Put the prompt back into editing with a reason, after a rejected value. */
export function rejectPrompt(state: PromptState, error: string): PromptState {
  return { ...state, status: 'editing', error };
}
