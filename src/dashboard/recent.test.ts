import { describe, it, expect } from 'vitest';
import { plainRecent } from './recent.js';

describe('recent activity, as the dashboard words it', () => {
  it('says a session moved, without how the move works inside', () => {
    // The log line is written for someone debugging a move. Someone glancing
    // at the dashboard wants to know that one happened and where to.
    expect(plainRecent(['22:31  switching to "phx" (no restart; takes effect within ~30s)'])).toEqual([
      '22:31 a session moved to phx',
    ]);
  });

  it('says a session started, an account ran out, and where its session went', () => {
    expect(
      plainRecent(
        [
          '09:00  session on work',
          '09:10  work hit its limit',
          '09:10  "work" hit its limit; moved this session to "spare" in place (no restart)',
        ],
        5,
      ),
    ).toEqual([
      '09:00 a session started on work',
      '09:10 work ran out',
      '09:10 work ran out; its session moved to spare',
    ]);
  });

  it('reads the two records of one relief as one event', () => {
    // A session relieved in place writes a notice and a log record about the
    // same move. Worded alike, they collapse like any other repeat.
    expect(
      plainRecent([
        '09:10  "work" hit its limit; moved this session to "spare" in place (no restart)',
        '09:10  seamless cap relief: work -> spare',
      ]),
    ).toEqual(['09:10 work ran out; its session moved to spare (x2)']);
  });

  it('says a move made from the dashboard without the timing in brackets', () => {
    expect(
      plainRecent([
        '10:00  moving api, web to spare (in place, within ~30s); new sessions start there too',
        '10:05  moving api to work (now, restarting); new sessions start there too',
      ]),
    ).toEqual([
      '10:00 moved api, web to spare; new sessions start there too',
      '10:05 moved api to work; new sessions start there too',
    ]);
  });

  it('says which session asked to move, without the word for the command', () => {
    expect(plainRecent(['10:00  swap: session 8470 asked to move to spare'])).toEqual([
      '10:00 session 8470 asked to move to spare',
    ]);
  });

  it('collapses a repeat into one line, with the latest time and how many', () => {
    expect(
      plainRecent([
        '22:31  switching to "a" (no restart; takes effect within ~30s)',
        '22:31  switching to "b" (no restart; takes effect within ~30s)',
        '22:49  session on b (x2)',
        '22:49  switching to "a" (no restart; takes effect within ~30s)',
        '22:49  switching to "b" (no restart; takes effect within ~30s)',
      ]),
    ).toEqual([
      '22:49 a session started on b (x2)',
      '22:49 a session moved to a (x2)',
      '22:49 a session moved to b (x2)',
    ]);
  });

  it('keeps to a few lines, the newest last', () => {
    expect(plainRecent(['01:00  one', '02:00  two', '03:00  three', '04:00  four'])).toEqual([
      '02:00 two',
      '03:00 three',
      '04:00 four',
    ]);
  });

  it('leaves out which build wrote a line', () => {
    // `ccx history` marks where the build changed. Here it is the longest
    // thing on a line that has to fit beside everything else.
    expect(plainRecent(['22:49  session on b (x3)  [ccx 2.3.1]'])).toEqual(['22:49 a session started on b (x3)']);
  });

  it('leaves a line it has no plainer words for as it was written', () => {
    expect(plainRecent(['08:00  renamed old to new', 'no time on this one'])).toEqual([
      '08:00 renamed old to new',
      'no time on this one',
    ]);
  });

  it('has nothing to say when nothing happened', () => {
    expect(plainRecent([])).toEqual([]);
  });
});
