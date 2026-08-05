import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmdirSync, existsSync } from 'node:fs';
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

  it('clamps a folded count rather than letting it lose precision', () => {
    // Two persisted counts can sum past the safe-integer range, and a count that
    // is not a safe integer gets dropped on the next read, turning "a great
    // many" into "once". Unreachable by appending, but this reads a file.
    const h = home();
    const huge = Number.MAX_SAFE_INTEGER;
    const lines = [
      JSON.stringify({ at: 1, msg: 'many', count: huge }),
      JSON.stringify({ at: 2, msg: 'many', count: 5 }),
    ].join('\n');
    writeFileSync(eventsFilePath(h), `${lines}\n`, 'utf8');

    const [record] = readEvents(h, 10);
    expect(record?.count).toBe(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(record?.count)).toBe(true);
    // And it survives a round trip, rather than reading back as a single event.
    appendEvent(h, 'many', 3);
    expect(readEvents(h, 10)[0]?.count).toBe(Number.MAX_SAFE_INTEGER);
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

describe('writing from more than one process at a time', () => {
  it('never throws, whatever the filesystem does', () => {
    // Telemetry must not be able to stop the thing it describes. The old write
    // renamed a temp file onto the target, which fails with EPERM on Windows
    // when another process is doing the same, and nothing wrapped the call: a
    // log line could take down a session start or a swap.
    const h = home();
    // A path that cannot be created: the parent is a FILE, not a directory.
    const blocked = path.join(h, 'a-file');
    writeFileSync(blocked, 'not a directory', 'utf8');
    expect(() => appendEvent(path.join(blocked, 'nested'), 'anything', 1000)).not.toThrow();
  });

  it('adds a line without rewriting what is already there', () => {
    // The property that makes concurrent writers safe: an append cannot erase
    // another writer's line, because it never rewrites the file.
    const h = home();
    appendEvent(h, 'first', 1000);
    const afterFirst = readFileSync(eventsFilePath(h), 'utf8');
    appendEvent(h, 'second', 2000);
    const afterSecond = readFileSync(eventsFilePath(h), 'utf8');
    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    expect(readEvents(h, 10).map((r) => r.msg)).toEqual(['first', 'second']);
  });
});

describe('keeping the file bounded without losing what matters', () => {
  it('folds a storm at trim time, so real events survive it', () => {
    // The headline. A caller stuck in a loop used to push every real event out
    // of a bounded window. Folding BEFORE the tail is taken means the storm
    // occupies one record however long it runs.
    const h = home();
    appendEvent(h, 'session on second', 1000);
    // Enough to pass the byte cap, so the trim actually runs and has to fold.
    for (let i = 0; i < 3000; i++) appendEvent(h, 'the same complaint repeated at length', 2000 + i);
    appendEvent(h, 'maxed hit its limit', 9000);

    const events = readEvents(h, 50);
    const messages = events.map((r) => r.msg);
    expect(messages).toContain('session on second');
    expect(messages).toContain('maxed hit its limit');
    expect(events.find((r) => r.msg === 'the same complaint repeated at length')?.count).toBeGreaterThan(100);
  });

  it('does not let the file grow without limit', () => {
    const h = home();
    for (let i = 0; i < 3000; i++) appendEvent(h, `distinct event number ${i} with some padding`, 1000 + i);
    const lines = readFileSync(eventsFilePath(h), 'utf8').split('\n').filter((l) => l.trim());
    // Trimming happens in bulk, so the file sits between the cap and the trim
    // threshold rather than exactly at the cap.
    expect(lines.length).toBeLessThanOrEqual(2000);
    // The most recent events are the ones kept.
    expect(readEvents(h, 2).map((r) => r.msg)).toEqual([
      'distinct event number 2998 with some padding',
      'distinct event number 2999 with some padding',
    ]);
  });

  it('survives a malformed line left by a partial write', () => {
    const h = home();
    appendEvent(h, 'before', 1000);
    writeFileSync(eventsFilePath(h), `${readFileSync(eventsFilePath(h), 'utf8')}{"at":123,"ms\n`, 'utf8');
    appendEvent(h, 'after', 2000);
    expect(readEvents(h, 10).map((r) => r.msg)).toEqual(['before', 'after']);
  });
});

describe('when another process is already compacting', () => {
  it('leaves the file alone instead of compacting alongside it', () => {
    // Two compactions at once can both merge the archive and both write it, so
    // one erases the other's merge. The rename makes rotation itself safe; the
    // archive write is what needs the lock. Held here directly, which is the
    // only deterministic way to observe it from a single process.
    const h = home();
    const file = eventsFilePath(h);
    const padding = 'y'.repeat(400);

    mkdirSync(path.dirname(file), { recursive: true });
    mkdirSync(`${file}.compact.lock`); // another process is mid-compaction
    try {
      for (let i = 0; i < 200; i++) appendEvent(h, `filler ${i} ${padding}`, 1000 + i);
      // Grew past the threshold and stayed whole: no compaction ran.
      expect(readFileSync(file, 'utf8').length).toBeGreaterThan(64 * 1024);
      expect(existsSync(`${file}.1`)).toBe(false);
    } finally {
      rmdirSync(`${file}.compact.lock`);
    }

    // Nothing was dropped while compaction was deferred.
    expect(readEvents(h, 500)).toHaveLength(200);

    // With the lock free, the next append compacts, and the history survives it.
    appendEvent(h, 'after the lock is released', 9001);
    expect(existsSync(`${file}.1`)).toBe(true);
    const messages = readEvents(h, 500).map((r) => r.msg);
    expect(messages).toContain('after the lock is released');
    expect(messages.some((m) => m.startsWith('filler 199'))).toBe(true);
  });
});
