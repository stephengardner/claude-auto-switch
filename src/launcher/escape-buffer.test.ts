import { describe, it, expect } from 'vitest';
import { splitTrailingPartial, createEscapeBuffer } from './escape-buffer.js';

const ESC = '\x1b';
const BEL = '\x07';
/** String Terminator: Escape followed by a backslash. */
const ST = `${ESC}\\`;

/** A mouse-motion report, the kind that flooded and leaked into the prompt. */
const MOUSE = `${ESC}[<35;112;43M`;

describe('splitTrailingPartial', () => {
  it('passes ordinary typing straight through', () => {
    expect(splitTrailingPartial('hello')).toEqual({ ready: 'hello', pending: '' });
  });

  it('holds a chunk that ends part-way through a mouse report', () => {
    expect(splitTrailingPartial(`${ESC}[<35;112`)).toEqual({
      ready: '',
      pending: `${ESC}[<35;112`,
    });
  });

  it('forwards the text before an incomplete sequence, and holds only the tail', () => {
    expect(splitTrailingPartial(`abc${ESC}[<35`)).toEqual({ ready: 'abc', pending: `${ESC}[<35` });
  });

  it('treats a finished sequence as ready', () => {
    expect(splitTrailingPartial(MOUSE)).toEqual({ ready: MOUSE, pending: '' });
    expect(splitTrailingPartial(`${ESC}[A`)).toEqual({ ready: `${ESC}[A`, pending: '' });
  });

  it('holds a bare Escape, which could still be the start of one', () => {
    expect(splitTrailingPartial(ESC)).toEqual({ ready: '', pending: ESC });
  });

  it('knows when an OSC string has ended', () => {
    expect(splitTrailingPartial(`${ESC}]0;title`).pending).toBe(`${ESC}]0;title`);
    expect(splitTrailingPartial(`${ESC}]0;title${BEL}`).pending).toBe('');
    expect(splitTrailingPartial(`${ESC}]0;title${ESC}\\`).pending).toBe('');
  });

  it('holds every kind of string sequence until its terminator', () => {
    // DCS, SOS, PM and APC run until a terminator just as OSC does. Treating
    // them as plain two-byte escapes would let them split as mouse reports did.
    for (const kind of ['P', 'X', '^', '_']) {
      const partial = `${ESC}${kind}payload`;
      // Both halves asserted: checking only what is held would miss a version
      // that held the right thing and mangled what it forwarded.
      expect(splitTrailingPartial(partial)).toEqual({ ready: '', pending: partial });
      expect(splitTrailingPartial(`${partial}${ST}`)).toEqual({
        ready: `${partial}${ST}`,
        pending: '',
      });
    }
  });

  it('ends on BEL for OSC only, since a BEL elsewhere is just payload', () => {
    // Only OSC takes BEL as a terminator, and that is an xterm compatibility
    // rule. Accepting it for the others would cut a sequence short on a BEL byte
    // inside its payload and forward the fragment: the same bug, better hidden.
    expect(splitTrailingPartial(`${ESC}]0;title${BEL}`).pending).toBe('');
    for (const kind of ['P', 'X', '^', '_']) {
      const withBel = `${ESC}${kind}pay${BEL}load`;
      expect(splitTrailingPartial(withBel)).toEqual({ ready: '', pending: withBel });
    }
  });

  it('reassembles a DCS sequence split across chunks', () => {
    const flushed: string[] = [];
    const buffer = createEscapeBuffer((t) => flushed.push(t), { setTimer: () => 1, clearTimer: () => {} });
    expect(buffer.push(`${ESC}Psome`)).toBe('');
    expect(buffer.push(`data${ST}`)).toBe(`${ESC}Psomedata${ST}`);
  });

  it('needs the third byte of an SS3 arrow key', () => {
    expect(splitTrailingPartial(`${ESC}O`).pending).toBe(`${ESC}O`);
    expect(splitTrailingPartial(`${ESC}OA`).pending).toBe('');
  });
});

describe('createEscapeBuffer', () => {
  /** A buffer whose flush timer is driven by hand, so nothing depends on timing. */
  function buffered() {
    const flushed: string[] = [];
    let fire: (() => void) | null = null;
    const buffer = createEscapeBuffer((t) => flushed.push(t), {
      setTimer: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimer: () => {
        fire = null;
      },
    });
    return { buffer, flushed, tick: () => fire?.() };
  }

  it('REASSEMBLES a sequence split across two chunks', () => {
    // The reported bug: forwarding these separately made Claude swallow the
    // prefix and print "35;112;43M" into the prompt as if it had been typed.
    const { buffer } = buffered();
    expect(buffer.push(`${ESC}[<35;112`)).toBe('');
    expect(buffer.push('4;43M')).toBe(`${ESC}[<35;1124;43M`);
  });

  it('handles a sequence split byte by byte', () => {
    const { buffer } = buffered();
    let out = '';
    for (const ch of MOUSE) out += buffer.push(ch);
    expect(out).toBe(MOUSE);
  });

  it('does not delay ordinary typing', () => {
    const { buffer } = buffered();
    expect(buffer.push('hello')).toBe('hello');
  });

  it('lets a lone Escape keypress through once nothing follows it', () => {
    // Held at first because it could be the start of a sequence, then released,
    // so pressing Escape still works.
    const { buffer, flushed, tick } = buffered();
    expect(buffer.push(ESC)).toBe('');
    tick();
    expect(flushed).toEqual([ESC]);
  });

  it('NEVER forwards an unfinished sequence when it gives up waiting', () => {
    // The bug this file was written to prevent, reintroduced by the file
    // itself. Holding "ESC[<35;101" and then flushing it wrote half a report
    // to the reader; the rest arrived next chunk and ";10M" appeared in the
    // input box. Once per pause in mouse movement, all day.
    const { buffer, flushed, tick } = buffered();
    expect(buffer.push(`${ESC}[<35;101`)).toBe('');
    tick(); // the wait runs out
    expect(flushed).toEqual([]); // dropped, not forwarded
    expect(buffer.abandoned()).toBe(1);
  });

  it('does not leave the ORPHANED TAIL to arrive as typed text', () => {
    // The other half of the same failure: after the fragment is abandoned, the
    // remainder of that report must not be forwarded either, or the reader
    // shows ";10M" exactly as before.
    const { buffer, tick } = buffered();
    buffer.push(`${ESC}[<35;101`);
    tick();
    // Whatever completes the abandoned report is inert on its own; what
    // matters is that the NEXT complete report still gets through intact.
    const rest = buffer.push(`;10M${ESC}[<35;102;11M`);
    expect(rest).not.toContain(`${ESC}[<35;101`);
    expect(rest.endsWith(`${ESC}[<35;102;11M`)).toBe(true);
  });

  it('still lets a lone Escape through, which is why the wait exists at all', () => {
    const { buffer, flushed, tick } = buffered();
    buffer.push(ESC);
    tick();
    expect(flushed).toEqual([ESC]);
    expect(buffer.abandoned()).toBe(0);
  });

  it('forgets a held fragment when the reader changes', () => {
    // An account swap hands the keyboard to a new session. A fragment held for
    // the old one is meaningless to the new one, and flushing it into a fresh
    // input box is the same stray characters by another route.
    const { buffer } = buffered();
    buffer.push(`${ESC}[<35;101`);
    buffer.reset();
    expect(buffer.push('hello')).toBe('hello');
    expect(buffer.abandoned()).toBe(1);
  });

  it('hands on a real Escape at shutdown, but never a fragment', () => {
    const a = buffered();
    a.buffer.push(ESC);
    expect(a.buffer.drain()).toBe(ESC);

    const b = buffered();
    b.buffer.push(`${ESC}[<35;101`);
    expect(b.buffer.drain()).toBe('');
    expect(b.buffer.abandoned()).toBe(1);
  });

  it('does not release a held sequence once the rest has arrived', () => {
    const { buffer, flushed, tick } = buffered();
    buffer.push(`${ESC}[<35`);
    expect(buffer.push(';112;43M')).toBe(MOUSE);
    tick(); // the old timer must not fire the sequence a second time
    expect(flushed).toEqual([]);
  });

  it('waits for the three payload bytes of an ORIGINAL-encoding mouse report', () => {
    // ESC [ M puts its final byte BEFORE its payload, so the ordinary CSI rule
    // calls it finished at the M and forwards it three bytes short. The
    // coordinates then arrive alone and are shown as typed text: the same bug
    // as the SGR one, by a different route, and reachable whenever a program
    // enables tracking without SGR encoding.
    const { buffer } = buffered();
    expect(buffer.push(`${ESC}[M`)).toBe('');
    expect(buffer.push(' !"')).toBe(`${ESC}[M !"`);
  });

  it('does not mistake a parameterised CSI M for the mouse form', () => {
    // Only a BARE ESC [ M is a mouse report; anything with parameters is an
    // ordinary sequence and must not be held waiting for payload that is
    // never coming.
    const { buffer } = buffered();
    expect(buffer.push(`${ESC}[3M`)).toBe(`${ESC}[3M`);
  });

  it('forwards a burst of complete sequences untouched', () => {
    const { buffer } = buffered();
    const burst = `${MOUSE}${ESC}[<35;125;50M`;
    expect(buffer.push(burst)).toBe(burst);
  });

  it('gives up what it holds on drain, and stops the timer', () => {
    // Drain used to hand the FRAGMENT back, and the caller wrote it on. That
    // is the same half-a-sequence that put stray characters on the screen, so
    // a fragment is now dropped here and only a real Escape survives. The
    // timer must still stop either way, or something fires after shutdown.
    const { buffer, flushed, tick } = buffered();
    buffer.push(`${ESC}[<35`);
    expect(buffer.drain()).toBe('');
    expect(buffer.abandoned()).toBe(1);
    tick();
    expect(flushed).toEqual([]); // drained, so nothing fires afterwards
  });
});
