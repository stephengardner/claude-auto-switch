/**
 * Tell the operator something happened, without disturbing the session.
 *
 * While Claude is running it owns the screen, so anything printed normally is
 * either scribbled over or corrupts the interface. Terminals accept a
 * notification request as an escape sequence instead: the terminal shows it
 * however it likes (a toast, a bell, a taskbar flash) and the sequence itself
 * draws nothing, so Claude's display is untouched.
 *
 * Best effort by nature. A terminal that does not understand the sequence
 * ignores it silently, which is exactly the desired behaviour.
 */

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/**
 * True while another program owns the terminal.
 *
 * Nothing here writes while that is set. An escape sequence RENDERS nothing,
 * which is why these were thought safe, but it is still bytes pushed into a
 * terminal that is mid-draw: land them inside a sequence the other program is
 * writing and its parser is left half-way through one, which garbles the display
 * and can leave the terminal in a mode that program is not expecting. Mouse
 * reports then arrive as ordinary typed text.
 *
 * Held HERE rather than checked by each caller, because a rule enforced at four
 * call sites is a rule that will be missed at the fifth.
 */
let terminalOwnedElsewhere = false;

/** Mark the terminal as owned (or not) by a program ccx is running. */
export function setTerminalOwnedElsewhere(owned: boolean): void {
  terminalOwnedElsewhere = owned;
}

/**
 * Replace control characters, which would end the escape sequence early and
 * spill raw text onto the screen, and keep the message short.
 */
function sanitize(message: string): string {
  let out = '';
  for (const ch of message.slice(0, 200)) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return out;
}

export interface NotifyOptions {
  /** Where to write; defaults to the real terminal. */
  stream?: { write(chunk: string): boolean } | undefined;
  /** Set false to stay completely silent. */
  enabled?: boolean;
}

/**
 * Ask the terminal to show `message`. Uses OSC 9, which Windows Terminal and
 * iTerm2 surface as a notification and other terminals ignore.
 */
export function notifyTerminal(message: string, options: NotifyOptions = {}): void {
  if (options.enabled === false || terminalOwnedElsewhere) return;
  const stream = options.stream ?? process.stderr;
  try {
    stream.write(`${ESC}]9;${sanitize(message)}${BEL}`);
  } catch {
    /* a terminal that rejects this is not a problem worth reporting */
  }
}

/**
 * Put `message` in the terminal's title bar. Claude sets the title too, so this
 * is a hint rather than a guarantee; harmless where it does not stick.
 */
export function setTerminalTitle(message: string, options: NotifyOptions = {}): void {
  if (options.enabled === false || terminalOwnedElsewhere) return;
  const stream = options.stream ?? process.stderr;
  try {
    stream.write(`${ESC}]0;${sanitize(message)}${BEL}`);
  } catch {
    /* ignore */
  }
}

/** Announce an account switch through every quiet channel available. */
export function notifyAccountSwitch(account: string, reason: string, options: NotifyOptions = {}): void {
  notifyTerminal(`ccx: now on ${account} (${reason})`, options);
  setTerminalTitle(`claude - ${account}`, options);
}
