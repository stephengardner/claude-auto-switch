import { describe, it, expect } from 'vitest';
import { descendantsIn, processRows } from './headless-session.js';

/**
 * Stopping a worker's Claude stops what it started too, on every platform.
 * Windows has `taskkill /T`; elsewhere the tree is read from `ps`, and this is
 * the reading of it. The start time is kept with each pid, so a process made
 * to stop is provably the one that was asked: a pid freed in the meantime and
 * given to something else starts later.
 */
describe('the processes a worker has to stop', () => {
  const table = [
    '    1     0 Thu Oct  9 05:00:00 2026',
    '  100     1 Thu Oct  9 05:21:10 2026',
    '  200   100 Thu Oct  9 05:21:11 2026',
    '  201   100 Thu Oct  9 05:21:12 2026',
    '  300   200 Thu Oct  9 05:21:13 2026',
    '  400     1 Thu Oct  9 05:21:14 2026',
    '  500   400 Thu Oct  9 05:21:15 2026',
    '',
  ].join('\n');

  it('reads each process with its parent and when it started', () => {
    expect(processRows(table)[1]).toEqual({ pid: 100, ppid: 1, started: 'Thu Oct  9 05:21:10 2026' });
  });

  it('finds children and grandchildren, and nothing else', () => {
    const rows = processRows(table);
    expect(descendantsIn(rows, 100).map((p) => p.pid)).toEqual([200, 201, 300]);
    expect(descendantsIn(rows, 300)).toEqual([]);
  });

  it('reads past lines that are not a process', () => {
    const rows = processRows('garbage\n 7 5 Mon Oct  6 10:00:00 2026\n\n  x y z\n 9 7 Mon Oct  6 10:00:01 2026');
    expect(descendantsIn(rows, 5).map((p) => p.pid)).toEqual([7, 9]);
  });

  it('cannot loop on a listing that names a process as its own ancestor', () => {
    const rows = processRows(' 2 1 a\n 1 2 b');
    expect(descendantsIn(rows, 1).map((p) => p.pid)).toEqual([2]);
  });
});
