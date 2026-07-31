/**
 * Never hand a HALF of an escape sequence to the program being relayed to.
 *
 * The terminal delivers input in whatever chunks it likes, and a single sequence
 * can straddle two of them. Forwarding chunk by chunk then delivers `ESC[<` in
 * one write and `35;112;43M` in the next, and a reader that does not carry state
 * across reads swallows the prefix and shows the remainder as typed text. That
 * is exactly what turned up in Claude's input box:
 *
 *     35;112;43M35;125;50M
 *
 * which is two mouse-motion reports with their `ESC[<` prefixes gone. Motion
 * tracking produces a flood of them, so it happened again and again.
 *
 * So a chunk that ends part-way through a sequence is held back until the rest
 * arrives. A lone Escape keypress looks identical to the start of a sequence, so
 * anything held is flushed after a short wait rather than being kept forever.
 */

const ESC = '\x1b';

/**
 * Split text into what is safe to forward now and a trailing part-sequence.
 *
 * Only the TAIL can be incomplete: anything before the last Escape has already
 * been terminated or is ordinary text.
 */
export function splitTrailingPartial(text: string): { ready: string; pending: string } {
  const at = text.lastIndexOf(ESC);
  if (at === -1) return { ready: text, pending: '' };
  const tail = text.slice(at);
  return isComplete(tail) ? { ready: text, pending: '' } : { ready: text.slice(0, at), pending: tail };
}

/** Does this sequence have everything it needs to be understood? */
function isComplete(seq: string): boolean {
  if (seq.length < 2) return false; // a bare Escape could still be the start
  const kind = seq[1] as string;

  // CSI: ESC [ params intermediates final. The final byte is what ends it.
  if (kind === '[') {
    for (let i = 2; i < seq.length; i += 1) {
      const code = (seq[i] as string).charCodeAt(0);
      if (code >= 0x40 && code <= 0x7e) return true;
    }
    return false;
  }

  // OSC: ESC ] ... terminated by BEL or by ESC \.
  if (kind === ']') return seq.includes('\x07') || seq.includes(`${ESC}\\`);

  // SS3 (ESC O A, the arrow keys on some terminals) needs one more byte.
  if (kind === 'O') return seq.length >= 3;

  // Anything else is a two-byte escape and is already whole.
  return true;
}

export interface EscapeBufferOptions {
  /** How long to hold a part-sequence before assuming it was a lone Escape. */
  flushAfterMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface EscapeBuffer {
  /** Feed a chunk; returns what should be forwarded now (may be empty). */
  push(chunk: string): string;
  /** Give up anything held and return it, for shutdown. */
  drain(): string;
}

/**
 * Reassembles input so no escape sequence is ever forwarded in pieces.
 *
 * `onFlush` receives a held part-sequence when the wait runs out, which is how a
 * lone Escape keypress still reaches the program.
 */
export function createEscapeBuffer(
  onFlush: (text: string) => void,
  options: EscapeBufferOptions = {},
): EscapeBuffer {
  const waitMs = options.flushAfterMs ?? 25;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));

  let pending = '';
  let timer: unknown = null;

  const stopTimer = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  return {
    push(chunk: string): string {
      stopTimer();
      const { ready, pending: held } = splitTrailingPartial(pending + chunk);
      pending = held;
      if (pending) {
        timer = setTimer(() => {
          const held2 = pending;
          pending = '';
          timer = null;
          if (held2) onFlush(held2);
        }, waitMs);
      }
      return ready;
    },
    drain(): string {
      stopTimer();
      const held = pending;
      pending = '';
      return held;
    },
  };
}
