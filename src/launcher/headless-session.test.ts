import { describe, it, expect } from 'vitest';
import { descendantsIn } from './headless-session.js';

/**
 * Stopping a worker's Claude stops what it started too, on every platform.
 * Windows has `taskkill /T`; elsewhere the tree is read from `ps`, and this is
 * the reading of it.
 */
describe('the processes a worker has to stop', () => {
  it('finds children and grandchildren, and nothing else', () => {
    const table = [
      '    1     0',
      '  100     1',
      '  200   100',
      '  201   100',
      '  300   200',
      '  400     1',
      '  500   400',
      '',
    ].join('\n');
    expect(descendantsIn(table, 100)).toEqual([200, 201, 300]);
    expect(descendantsIn(table, 300)).toEqual([]);
  });

  it('reads past lines that are not a pid and a parent', () => {
    expect(descendantsIn('garbage\n 7 5\n\n  x y\n 9 7', 5)).toEqual([7, 9]);
  });

  it('cannot loop on a listing that names a process as its own ancestor', () => {
    expect(descendantsIn(' 2 1\n 1 2', 1)).toEqual([2]);
  });
});
