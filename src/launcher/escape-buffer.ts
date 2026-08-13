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

  // A mouse report that has been PROVEN dead, because what followed it cannot
  // belong to one. Waiting on it would swallow whatever that was, and the old
  // rule was worse still: any character in the final-byte range ended the
  // sequence, so typing "hello" after a stalled fragment sent the child
  // "ESC[<35;10h" (a private-mode set it never asked for) and showed "ello".
  const dead = deadMouseFragment(tail);
  if (dead !== null) return { ready: text.slice(0, at) + tail.slice(dead), pending: '' };

  return isComplete(tail) ? { ready: text, pending: '' } : { ready: text.slice(0, at), pending: tail };
}

/**
 * Where a mouse report stops making sense, or null while it still might.
 *
 * Only `ESC [ <` sequences: their grammar is known exactly (digits and
 * semicolons, ended by M or m), so anything else is proof the sequence is
 * never going to arrive, and the bytes from that point are real input.
 */
function deadMouseFragment(seq: string): number | null {
  if (!seq.startsWith(`${ESC}[<`)) return null;
  for (let i = 3; i < seq.length; i += 1) {
    const ch = seq[i] as string;
    if (/[0-9;]/.test(ch)) continue;
    return /[Mm]/.test(ch) ? null : i; // a final byte is fine; anything else is not
  }
  return null; // still only digits and separators: it could yet be finished
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
  /** Injected in tests, so the suffix window does not depend on real time. */
  now?: () => number;
}

/**
 * The remains of a mouse report whose beginning was dropped.
 *
 * Dropping the beginning is only half the job. The rest of that report still
 * arrives, and it carries no Escape, so nothing downstream can tell it from
 * something the operator typed: `;10M` is forwarded and shown, which is the
 * `;30M` in the reported screenshot. So what was abandoned is remembered just
 * long enough to swallow its own tail.
 */
interface ExpectedTail {
  /**
   * The parameters the dropped report has been given so far, fragment
   * included. Kept in full rather than counted, because only the actual text
   * can say whether what arrives could FINISH a real report: counting
   * separators alone accepted `35;101;` with an empty Cy, and turned a typed
   * `12M` into `M` by eating the digits.
   */
  paramsSoFar: string;
}

/** A finished SGR report carries exactly Cb;Cx;Cy. */
const COMPLETE_SGR = /^\d+;\d+;\d+$/;
/** Still on its way to that: digits and at most two separators, nothing else. */
const PARTIAL_SGR = /^\d*(?:;\d*){0,2}$/;

/**
 * What, if anything, an abandoned fragment will send along afterwards.
 *
 * Only the SGR form, and deliberately. The original encoding's payload is
 * three RAW bytes that can be any character at all, so `abc` typed after an
 * abandoned `ESC [ M` is indistinguishable from a real report's payload, and
 * eating three real keystrokes is a worse failure than showing three stray
 * characters. A genuine payload follows its prefix in the same breath anyway,
 * so it is never the thing that is still missing when the wait runs out.
 */
export function tailExpectedAfter(fragment: string): ExpectedTail | null {
  const sgr = /^\x1b\[<([0-9;]*)$/.exec(fragment);
  if (!sgr) return null;
  return { paramsSoFar: sgr[1] ?? '' };
}

/**
 * Eat the part of `chunk` that belongs to a report already dropped.
 *
 * Deliberately narrow, because everything it takes is something the operator
 * might have typed. Only digits and semicolons, optionally finished by M or m,
 * and a lone final byte only when the dropped report already had its
 * parameters. So "hello" survives, and so does a bare "M" typed after a
 * fragment that was nowhere near complete.
 */
export function consumeExpectedTail(
  chunk: string,
  expected: ExpectedTail,
): { rest: string; still: ExpectedTail | null } {
  const eaten = /^[0-9;]*[Mm]?/.exec(chunk)?.[0] ?? '';
  if (eaten.length === 0) return { rest: chunk, still: null }; // not ours after all
  const finished = /[Mm]$/.test(eaten);
  // The WHOLE report, fragment included: a tail supplying its last parameter
  // and its final byte together is still one report.
  const params = expected.paramsSoFar + eaten.replace(/[Mm]$/, '');

  // Nothing is taken unless it could actually finish a real report. Anything
  // else is the operator typing, and taking a single character of that is a
  // worse failure than the stray character this exists to prevent: one is
  // visible, the other is silent.
  const couldFinish = finished ? COMPLETE_SGR.test(params) : PARTIAL_SGR.test(params);
  if (!couldFinish) return { rest: chunk, still: null };

  return {
    rest: chunk.slice(eaten.length),
    // Not finished yet: the tail is itself split, so keep waiting with what
    // has been supplied so far.
    still: finished ? null : { paramsSoFar: params },
  };
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

  const now = options.now ?? (() => Date.now());

  let pending = '';
  let timer: unknown = null;
  let abandonedCount = 0;
  /** The tail of a dropped report, and how long it is worth waiting for. */
  let expected: ExpectedTail | null = null;
  let expectedUntil = 0;

  const stopTimer = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  /** Give up on the fragment being held, remembering what it still owes. */
  const abandon = (fragment: string): void => {
    abandonedCount += 1;
    expected = tailExpectedAfter(fragment);
    // Bounded, so a keystroke that happens to look like a tail much later is
    // still delivered. A genuine tail arrives in the same breath as the rest.
    expectedUntil = now() + abandonMs;
  };

  return {
    push(chunk: string): string {
      stopTimer();
      // Swallow what belongs to a report whose beginning was already dropped.
      // Without this the fix is half a fix: the prefix is gone and the tail
      // still reaches the reader as text, which is the stray characters.
      if (expected) {
        if (now() <= expectedUntil) {
          const { rest, still } = consumeExpectedTail(chunk, expected);
          chunk = rest;
          expected = still;
        } else {
          expected = null;
        }
      }
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
            abandon(held2);
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
      // Nothing is armed here either: the run is ending, so there is no later
      // input of ours to take, and the terminal belongs to the shell next.
      expected = null;
      expectedUntil = 0;
      return '';
    },
    reset(): void {
      stopTimer();
      if (pending) abandonedCount += 1;
      pending = '';
      // Cleared, never armed. Reset means the keyboard is passing to a new
      // reader, and arming a tail here would let the next thing the operator
      // types be eaten on behalf of a session that has already ended.
      expected = null;
      expectedUntil = 0;
    },
    abandoned(): number {
      return abandonedCount;
    },
  };
}
