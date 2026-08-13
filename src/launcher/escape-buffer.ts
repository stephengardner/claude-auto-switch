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
 * which is two mouse reports with their `ESC[<` prefixes gone. Mouse tracking
 * produces a flood of them, so it happened again and again.
 *
 * So a chunk that ends part-way through a sequence is held back until the rest
 * arrives. A lone Escape keypress looks identical to the START of a sequence,
 * so something has to give up waiting eventually.
 *
 * WHAT IS GIVEN UP MATTERS, and getting it wrong reintroduced the whole bug.
 * The first version flushed whatever it was holding, which meant an unfinished
 * `ESC[<35;101` was written on its own; the reader consumed the prefix, the
 * rest arrived in the next chunk, and `;10M` appeared in the input box. The
 * buffer built to prevent split sequences was splitting them itself, once per
 * pause in mouse movement. Measured against the shipped build:
 *
 *     FLUSH  "\x1b[<35;101"     <- forwarded on its own
 *     READY  ";10M\x1b[<35;102;11M"   <- and the tail lands as text
 *
 * So only a HELD ESCAPE THAT COULD BE A KEYPRESS is ever flushed. Anything
 * already known to be an unfinished sequence is waited on, and dropped if it
 * never completes: a truncated mouse report is worth nothing, and forwarding
 * it can only corrupt what the reader shows.
 */

const ESC = '\x1b';
const BEL = '\x07';
/** String Terminator: Escape followed by a backslash. */
const ST = `${ESC}\\`;
/** Operating System Command, the one string kind that also ends on BEL. */
const OSC = ']';
/** Introducers whose content runs until a terminator rather than a fixed length. */
const STRING_KINDS = new Set([OSC, 'P', 'X', '^', '_']);

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

  // The ORIGINAL mouse encoding: ESC [ M then exactly three raw bytes for
  // button, column and row. Its final byte arrives before its payload, so the
  // rule below would call it complete at the `M` and forward it three bytes
  // short; the coordinates then arrive on their own and are shown as text.
  // This is only reachable on the INPUT path, where a bare `ESC [ M` is always
  // a mouse report and never Delete-Line.
  if (kind === '[' && seq[2] === 'M') return seq.length >= 6;

  // CSI: ESC [ params intermediates final. The final byte is what ends it.
  if (kind === '[') {
    for (let i = 2; i < seq.length; i += 1) {
      const code = (seq[i] as string).charCodeAt(0);
      if (code >= 0x40 && code <= 0x7e) return true;
    }
    return false;
  }

  // The string kinds run until a terminator rather than for a fixed length:
  // OSC (]), DCS (P), SOS (X), PM (^) and APC (_). Treating any of them as a
  // plain two-byte escape would let it split exactly the way the mouse reports
  // were splitting, which is the whole bug this file exists for.
  //
  // Only OSC ends on BEL. That is an xterm compatibility rule, not a general
  // one, and applying it to the others would end a sequence early on a BEL byte
  // that is simply part of its payload, forwarding the fragment: the same bug
  // again, harder to spot.
  if (kind === OSC) return seq.includes(BEL) || seq.includes(ST);
  if (STRING_KINDS.has(kind)) return seq.includes(ST);

  // SS3 (ESC O A, the arrow keys on some terminals) needs one more byte.
  if (kind === 'O') return seq.length >= 3;

  // Anything else is a two-byte escape and is already whole.
  return true;
}

/**
 * Could this held text be a real Escape KEYPRESS rather than the start of a
 * sequence the terminal has not finished sending?
 *
 * A bare Escape can be either, and waiting forever would swallow the key. Once
 * an introducer has arrived (`ESC [`, `ESC O`, `ESC ]`, ...) it is no longer
 * ambiguous: the terminal is mid-sequence, and what is held is a fragment that
 * must never reach the reader as text.
 *
 * `ESC` followed by an ordinary character is Alt+key, which is whole already
 * and never reaches this question.
 */
export function couldBeEscapeKey(held: string): boolean {
  return held === ESC;
}

export interface EscapeBufferOptions {
  /** How long to hold a lone Escape before treating it as the key. */
  flushAfterMs?: number;
  /**
   * How long to wait for an unfinished SEQUENCE before giving up on it. A real
   * one completes within microseconds, so anything still unfinished this much
   * later is debris; it is dropped rather than forwarded, because forwarding a
   * truncated sequence is what puts stray characters on the screen.
   */
  abandonAfterMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface EscapeBuffer {
  /** Feed a chunk; returns what should be forwarded now (may be empty). */
  push(chunk: string): string;
  /** Give up anything held and return it, for shutdown. */
  drain(): string;
  /**
   * Forget anything held, forwarding nothing.
   *
   * Used when the reader changes (an account swap starts a new session): a
   * fragment held for the old one is meaningless to the new one, and flushing
   * it into a fresh input box is the same stray-characters bug by another
   * route.
   */
  reset(): void;
  /** How many fragments have been abandoned, for diagnostics. */
  abandoned(): number;
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
  const abandonMs = options.abandonAfterMs ?? 250;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));

  let pending = '';
  let timer: unknown = null;
  let abandonedCount = 0;

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
        // Two different waits, because two different things are being waited
        // for. A lone Escape is a KEY and must be delivered. An unfinished
        // sequence is DEBRIS once it is late, and delivering it is the bug.
        const isKey = couldBeEscapeKey(pending);
        timer = setTimer(
          () => {
            const held2 = pending;
            pending = '';
            timer = null;
            if (!held2) return;
            if (couldBeEscapeKey(held2)) {
              onFlush(held2);
              return;
            }
            abandonedCount += 1;
          },
          isKey ? waitMs : abandonMs,
        );
      }
      return ready;
    },
    drain(): string {
      stopTimer();
      const held = pending;
      pending = '';
      // Only a real key is worth handing on at shutdown; a fragment is not.
      if (couldBeEscapeKey(held)) return held;
      if (held) abandonedCount += 1;
      return '';
    },
    reset(): void {
      stopTimer();
      if (pending) abandonedCount += 1;
      pending = '';
    },
    abandoned(): number {
      return abandonedCount;
    },
  };
}
