import { describe, it, expect } from 'vitest';
import { splitTrailingPartial, createEscapeBuffer } from './escape-buffer.js';

const ESC = '\x1b';
const BEL = '\x07';

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

  it('does not release a held sequence once the rest has arrived', () => {
    const { buffer, flushed, tick } = buffered();
    buffer.push(`${ESC}[<35`);
    expect(buffer.push(';112;43M')).toBe(MOUSE);
    tick(); // the old timer must not fire the sequence a second time
    expect(flushed).toEqual([]);
  });

  it('forwards a burst of complete sequences untouched', () => {
    const { buffer } = buffered();
    const burst = `${MOUSE}${ESC}[<35;125;50M`;
    expect(buffer.push(burst)).toBe(burst);
  });

  it('gives up what it holds on drain, and stops the timer', () => {
    const { buffer, flushed, tick } = buffered();
    buffer.push(`${ESC}[<35`);
    expect(buffer.drain()).toBe(`${ESC}[<35`);
    tick();
    expect(flushed).toEqual([]); // drained, so nothing fires afterwards
  });
});
