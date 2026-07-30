/**
 * The one-line text box the dashboard uses to ask for a name.
 *
 * Pure on purpose, like the key dispatcher next to it: typing, deleting and
 * confirming are decided here, so the behaviour can be tested without a
 * terminal. The dashboard only draws the result.
 */

export type PromptStatus = 'editing' | 'submit' | 'cancel';

export interface PromptState {
  /** What the prompt is for, so the caller knows what to do on submit. */
  kind: string;
  /** The question shown to the operator. */
  label: string;
  text: string;
  status: PromptStatus;
  /** Set when the typed value is not usable, shown under the box. */
  error?: string;
}

export function openPrompt(kind: string, label: string, text = ''): PromptState {
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
 * Apply one keypress, or one chunk of them.
 *
 * Enter confirms, Escape and Ctrl-C cancel, Ctrl-U clears the line. Anything
 * printable is appended; control keys and escape sequences (arrow keys and the
 * like) are ignored rather than inserted as junk, which is what makes a hand
 * rolled text box feel broken.
 */
export function promptKey(state: PromptState, key: string, byte0?: number): PromptState {
  if (state.status !== 'editing') return state;
  if (byte0 === CTRL_C) return { ...state, status: 'cancel' };
  // A bare Escape cancels; Escape followed by more bytes is an arrow or function
  // key, which must not cancel and must not be typed into the box either.
  if (byte0 === ESCAPE) return key.length === 1 ? { ...state, status: 'cancel' } : state;
  if (byte0 === CTRL_U) return { ...state, text: '', ...clearError(state) };
  if (byte0 === BACKSPACE || byte0 === DELETE) {
    return { ...state, text: state.text.slice(0, -1), ...clearError(state) };
  }

  // A single chunk can carry several keystrokes: typing at speed, or pasting,
  // delivers the name and the Enter together. Confirming has to work then too, so
  // an Enter anywhere in the chunk ends the box and keeps what came before it.
  // Without this the box could not be confirmed at real typing speed at all.
  const chars = [...key];
  const enterAt = chars.findIndex(isEnter);
  const typed = enterAt >= 0 ? chars.slice(0, enterAt) : chars;
  const next: PromptState = {
    ...state,
    text: state.text + printableOnly(typed),
    ...clearError(state),
  };
  if (enterAt >= 0) return { ...next, status: 'submit' };
  return next.text === state.text ? state : next;
}

function isEnter(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code === CARRIAGE_RETURN || code === LINE_FEED;
}

/** Drop control characters, so a stray byte cannot end up inside a name. */
function printableOnly(chars: string[]): string {
  return chars
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= SPACE && code !== DELETE;
    })
    .join('');
}

/** Typing again clears a complaint about the previous value. */
function clearError(state: PromptState): { error?: undefined } {
  return state.error ? { error: undefined } : {};
}

/** Put the prompt back into editing with a reason, after a rejected value. */
export function rejectPrompt(state: PromptState, error: string): PromptState {
  return { ...state, status: 'editing', error };
}
