import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendEvent, readEvents, formatEvent, eventsFilePath } from './log.js';

function home(): string {
  return mkdtempSync(path.join(tmpdir(), 'cas-ev-'));
}

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
