import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendEvent, readEvents, formatEvent, eventsFilePath } from './log.js';

function home(): string {
  return mkdtempSync(path.join(tmpdir(), 'cas-ev-'));
}

describe('a message that repeats', () => {
  it('COLLAPSES into one record instead of filling the log', () => {
    // This is the whole point. The log is bounded, so a caller stuck in a loop
    // used to empty the window of everything else: it happened twice, once
    // filling all 200 entries with a single line, which blinded `ccx dashboard`
    // and `ccx history` exactly when they were the tools being reached for.
    const h = home();
    appendEvent(h, 'session on second', 1000);
    for (let i = 0; i < 500; i++) appendEvent(h, 'the same complaint', 2000 + i);

    const records = readEvents(h, 200);
    expect(records).toHaveLength(2);
    expect(records[0]?.msg).toBe('session on second');
    expect(records[1]?.count).toBe(500);
  });

  it('keeps the time of the LAST occurrence, not the first', () => {
    // "Is this still happening" is the question being asked of a repeat.
    const h = home();
    appendEvent(h, 'again', 1000);
    appendEvent(h, 'again', 9000);
    expect(readEvents(h)[0]?.at).toBe(9000);
  });

  it('only collapses CONSECUTIVE repeats, so history is not rewritten', () => {
    const h = home();
    appendEvent(h, 'a', 1000);
    appendEvent(h, 'b', 2000);
    appendEvent(h, 'a', 3000);
    expect(readEvents(h).map((r) => r.msg)).toEqual(['a', 'b', 'a']);
  });

  it('shows the count when formatting, and nothing extra for a single event', () => {
    expect(formatEvent({ at: Date.UTC(2026, 7, 4, 12, 0), msg: 'once' })).not.toContain('(x');
    expect(formatEvent({ at: Date.UTC(2026, 7, 4, 12, 0), msg: 'lots', count: 200 })).toContain(
      '(x200)',
    );
  });

  it('RESCUES a log that was already filled with separate repeats', () => {
    // The case the write-side collapse cannot help with, and the one that
    // matters most in practice: a log written before collapsing existed is
    // already 200 separate lines, and every real event has been pushed out.
    // Folding on read makes it readable again immediately.
    const h = home();
    const lines = [
      JSON.stringify({ at: 1, msg: 'session on second' }),
      ...Array.from({ length: 199 }, (_, i) => JSON.stringify({ at: 100 + i, msg: 'the same complaint' })),
    ].join('\n');
    writeFileSync(eventsFilePath(h), `${lines}\n`, 'utf8');

    const records = readEvents(h, 200);
    expect(records).toHaveLength(2);
    expect(records[0]?.msg).toBe('session on second');
    expect(records[1]?.count).toBe(199);
    // The time shown is the most recent occurrence.
    expect(records[1]?.at).toBe(298);
  });

  it('counts the LIMIT in things that happened, not copies of one of them', () => {
    // Asking for the last 5 events should not spend all five on one repeat.
    const h = home();
    const lines = [
      ...Array.from({ length: 50 }, (_, i) => JSON.stringify({ at: i, msg: 'noise' })),
      JSON.stringify({ at: 900, msg: 'a real event' }),
    ].join('\n');
    writeFileSync(eventsFilePath(h), `${lines}\n`, 'utf8');
    expect(readEvents(h, 5).map((r) => r.msg)).toEqual(['noise', 'a real event']);
  });

  it('ignores a count that is not a whole number above one', () => {
    // Only a corrupted or hand-edited line produces these, and carrying one
    // through would render "(x2.5)" or serialise Infinity back out as null.
    const h = home();
    const lines = [
      { at: 1000, msg: 'fraction', count: 2.5 },
      { at: 2000, msg: 'infinite', count: Number.POSITIVE_INFINITY },
      { at: 3000, msg: 'negative', count: -5 },
      { at: 4000, msg: 'texty', count: '9' },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n');
    writeFileSync(eventsFilePath(h), `${lines}\n`, 'utf8');
    for (const record of readEvents(h, 10)) expect(record.count).toBeUndefined();
  });

  it('reads records written before counts existed', () => {
    // Old lines have no count field; they must still read as a single event.
    const h = home();
    writeFileSync(eventsFilePath(h), `${JSON.stringify({ at: 1000, msg: 'old' })}\n`, 'utf8');
    expect(readEvents(h)).toEqual([{ at: 1000, msg: 'old' }]);
    // And a repeat of an old line still collapses onto it.
    appendEvent(h, 'old', 2000);
    expect(readEvents(h)).toEqual([{ at: 2000, msg: 'old', count: 2 }]);
  });
});

describe('event log', () => {
  it('returns [] when there is no log yet', () => {
    expect(readEvents(home())).toEqual([]);
  });

  it('appends and reads back events oldest-first', () => {
    const h = home();
    appendEvent(h, 'first', 1000);
    appendEvent(h, 'second', 2000);
    expect(readEvents(h).map((r) => r.msg)).toEqual(['first', 'second']);
  });

  it('honors the limit, keeping the most recent', () => {
    const h = home();
    for (let i = 0; i < 10; i++) appendEvent(h, `e${i}`, i);
    expect(readEvents(h, 3).map((r) => r.msg)).toEqual(['e7', 'e8', 'e9']);
  });

  it('skips malformed lines', () => {
    const h = home();
    appendEvent(h, 'ok', 1000);
    writeFileSync(eventsFilePath(h), `${readFileSync(eventsFilePath(h), 'utf8')}not json\n{"at":1}\n`);
    expect(readEvents(h).map((r) => r.msg)).toEqual(['ok']);
  });

  it('formats an event as HH:MM  message', () => {
    expect(formatEvent({ at: 1_700_000_000_000, msg: 'swap a->b' })).toMatch(/^\d{2}:\d{2}  swap a->b$/);
  });
});
