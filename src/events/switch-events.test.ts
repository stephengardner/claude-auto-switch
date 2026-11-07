import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendEvent, type EventRecord } from './log.js';
import { readSwitchEvents, switchDetail, switchEvents, toSwitchEvent } from './switch-events.js';

describe('what a writer records with a move', () => {
  it('reads back as the move it was written for, from each constructor the writers use', () => {
    const back = (detail: ReturnType<typeof switchDetail.moved>) => {
      const event = toSwitchEvent({ at: 5, msg: 'words', ...detail });
      return event && [event.kind, event.from, event.to, event.reason];
    };
    // session.ts, a move made in place on request.
    expect(back(switchDetail.moved('a', 'b', 'asked', { targeted: true }))).toEqual([
      'moved',
      'a',
      'b',
      'asked',
    ]);
    // ccx swap, and ccx auto's proactive switch.
    expect(back(switchDetail.asked(null, 'b', 'asked', { pid: 9 }))).toEqual([
      'move-asked',
      null,
      'b',
      'asked',
    ]);
    expect(back(switchDetail.asked('a', 'b', 'proactive'))).toEqual([
      'move-asked',
      'a',
      'b',
      'proactive',
    ]);
    // session.ts, a session starting, and one carrying on after a restart.
    expect(back(switchDetail.sessionStart('a', false))).toEqual([
      'started',
      null,
      'a',
      'session-start',
    ]);
    expect(back(switchDetail.sessionStart('a', true))).toEqual(['started', null, 'a', 'continued']);
  });
});

const record = (
  kind: string,
  data: Record<string, unknown>,
  extra: Partial<EventRecord> = {},
): EventRecord => ({
  at: 1000,
  msg: 'a sentence for a person, never read',
  kind,
  data,
  ...extra,
});

describe('the moves in the event log, as values', () => {
  it('reads each kind of move from its kind and data', () => {
    const records = [
      record('session-start', { account: 'a', continued: false }),
      record('capped', { account: 'a', reason: 'confirmed', resetAt: 5 }),
      record('cap-relief', { from: 'a', to: 'b' }),
      record('switch-request', { from: 'b', to: 'c', reason: 'proactive' }),
      record('move-pending', { from: 'b', to: 'c' }),
      record('switch', { from: 'b', to: 'c', reason: 'asked', targeted: true }),
      record('move-failed', { from: 'c', to: 'd' }),
      record('editor-move', { from: 'a', to: 'c' }),
      record('session-start', { account: 'c', continued: true }),
    ];
    expect(switchEvents(records).map((e) => [e.kind, e.from, e.to, e.reason])).toEqual([
      ['started', null, 'a', 'session-start'],
      ['ran-out', 'a', null, 'capacity'],
      ['moved', 'a', 'b', 'capacity'],
      ['move-asked', 'b', 'c', 'proactive'],
      ['move-waiting', 'b', 'c', 'asked'],
      ['moved', 'b', 'c', 'asked'],
      ['move-failed', 'c', 'd', 'asked'],
      ['editor-moved', 'a', 'c', 'follows-active'],
      ['started', null, 'c', 'continued'],
    ]);
  });

  it('carries when, how many times in a row, and which ccx wrote it', () => {
    expect(
      toSwitchEvent(record('cap-relief', { from: 'a', to: 'b' }, { at: 7, count: 3, v: '2.6.33' })),
    ).toEqual({
      at: 7,
      kind: 'moved',
      from: 'a',
      to: 'b',
      reason: 'capacity',
      count: 3,
      v: '2.6.33',
    });
  });

  it('takes no folder for an account: the editor being given a folder of its own is not a move', () => {
    const made = record('editor-move', { from: '/home/me/.claude', to: 'a' });
    const takenOver = record('editor-move', { from: 'C:\\Users\\me\\.claude.aside', to: 'a' });
    expect(switchEvents([made, takenOver])).toEqual([]);
    // From no account at all, onto one, is.
    expect(toSwitchEvent(record('editor-move', { to: 'a' }))?.kind).toBe('editor-moved');
  });

  it('is nothing for a record without its accounts, or of any other kind', () => {
    expect(
      switchEvents([
        // Written before a capped record named its account.
        record('capped', { reason: 'confirmed' }),
        record('cap-relief', { from: 'a' }),
        record('credential-sync', { account: 'a' }),
        { at: 1, msg: 'session on a' },
      ]),
    ).toEqual([]);
  });

  it('says unknown for a reason it does not know', () => {
    expect(toSwitchEvent(record('switch', { from: 'a', to: 'b', reason: 'whim' }))?.reason).toBe(
      'unknown',
    );
  });

  it('counts moves, not events, when asked for the last few', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-switch-events-'));
    let at = 1;
    for (const to of ['b', 'c', 'd']) {
      appendEvent(home, `moved to ${to}`, at++, { kind: 'cap-relief', data: { from: 'a', to } });
      for (let i = 0; i < 5; i += 1)
        appendEvent(home, `noise ${at}`, at++, { kind: 'credential-sync' });
    }
    expect(readSwitchEvents(home, 2).map((e) => e.to)).toEqual(['c', 'd']);
  });
});
