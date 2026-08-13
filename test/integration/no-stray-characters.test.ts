import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { openTerminalInput } from '../../src/launcher/terminal-input.js';

/**
 * The whole path, against the bytes the operator actually reported.
 *
 * The unit tests each pin one rule. This one asserts the property those rules
 * exist for, end to end and through the real relay: while a program is running
 * that asked for clicks, NOTHING a mouse does can put a character in front of
 * it. That property survived two previous fixes only in theory, so it is
 * asserted here against a stream chunked the way a terminal really chunks it,
 * including the pauses that made the old code give up mid-sequence.
 */

const ESC = '\x1b';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What Claude declares on startup: alternate screen, click tracking, SGR. */
const CLAUDE_DECLARES = `${ESC}[?1049h${ESC}[?1000h${ESC}[?1006h`;

/** A movement report: 35 is 32 (motion) plus 3 (no button held). */
const motion = (x: number, y: number): string => `${ESC}[<35;${x};${y}M`;

/**
 * Anything that would show up as typed text.
 *
 * Deliberately not an exact-string check: the failure mode is debris of a shape
 * nobody predicted, so this asks whether ANY report residue survived rather
 * than whether one particular fragment did.
 */
function debrisIn(text: string): string[] {
  return [
    ...text.matchAll(/(?:^|[^\x1b[])(<?\d+;\d+;\d+[Mm])/g),
    ...text.matchAll(/(?:^|[^0-9;])(;\d+[Mm])/g),
  ].map((m) => m[1] as string);
}

async function relay() {
  const stdin = new PassThrough();
  const corrections: string[] = [];
  const received: string[] = [];
  const input = openTerminalInput(stdin as unknown as NodeJS.ReadStream, {
    out: (text) => corrections.push(text),
  });
  const detach = input.attach((text) => received.push(text));
  // The child starts and says what it wants, exactly as Claude does.
  input.observeChildOutput(CLAUDE_DECLARES);
  return {
    input,
    detach,
    corrections,
    /** Feed a chunk the way the terminal would, then let the relay run. */
    async feed(chunk: string, thenWaitMs = 5) {
      stdin.write(chunk);
      await sleep(thenWaitMs);
    },
    seen: () => received.join(''),
    close: () => {
      detach();
      input.close();
    },
  };
}

describe('a mouse moving over a program that asked for clicks', () => {
  it('puts NOT ONE CHARACTER in front of it, however the flood is chunked', async () => {
    const r = await relay();

    // A realistic flood, split at the boundaries that broke the old code:
    // mid-parameters, mid-introducer, and right after the final byte.
    await r.feed(`${motion(99, 8)}${motion(100, 9)}${ESC}[<35;101`);
    await r.feed(';10M' + motion(102, 11).slice(0, 4));
    await r.feed(motion(102, 11).slice(4));
    await r.feed(`${motion(316, 17)}${ESC}`);
    await r.feed(`[<35;237;16M${motion(158, 35)}`);

    expect(debrisIn(r.seen())).toEqual([]);
    expect(r.seen()).toBe('');
    r.close();
  });

  it('puts nothing in front of it when the flood STOPS mid-report', async () => {
    // The exact shape that produced ";30M": a chunk ends part-way through a
    // report, the mouse pauses long enough for the wait to run out, and the
    // rest arrives afterwards.
    const r = await relay();

    await r.feed(`${motion(99, 8)}${ESC}[<35;101`);
    await sleep(320); // longer than the abandon wait: the fragment is dropped
    await r.feed(';30M');
    await r.feed(motion(84, 3));

    expect(debrisIn(r.seen())).toEqual([]);
    expect(r.seen()).toBe('');
    r.close();
  });

  it('tells the terminal to stop sending them, rather than absorbing them forever', async () => {
    const r = await relay();
    await r.feed(motion(99, 8));
    expect(r.corrections.join('')).toContain(`${ESC}[?1003l`);
    r.close();
  });
});

describe('what must still get through, unharmed', () => {
  it('delivers ordinary typing during the flood', async () => {
    const r = await relay();
    await r.feed(`${motion(99, 8)}ccx models fable${motion(100, 9)}`);
    await r.feed(' opus\r');
    expect(r.seen()).toBe('ccx models fable opus\r');
    r.close();
  });

  it('delivers typing that arrives right after a dropped fragment', async () => {
    const r = await relay();
    await r.feed(`${ESC}[<35;101`);
    await sleep(320); // the fragment is abandoned here
    await r.feed('hello');
    expect(r.seen()).toBe('hello');
    r.close();
  });

  it('delivers arrow keys and a real Escape keypress', async () => {
    const r = await relay();
    await r.feed(`${ESC}[A${ESC}[B`);
    await r.feed(ESC);
    await sleep(60); // the lone Escape is held briefly, then released as a key
    expect(r.seen()).toBe(`${ESC}[A${ESC}[B${ESC}`);
    r.close();
  });

  it('delivers a bracketed paste whole', async () => {
    const r = await relay();
    const paste = `${ESC}[200~some pasted text${ESC}[201~`;
    await r.feed(paste);
    expect(r.seen()).toBe(paste);
    r.close();
  });

  it('delivers mouse reports to a program that DID ask for motion', async () => {
    const r = await relay();
    r.input.observeChildOutput(`${ESC}[?1003h`); // this one wants them
    await r.feed(motion(99, 8));
    expect(r.seen()).toBe(motion(99, 8));
    r.close();
  });
});
