import { describe, it, expect } from 'vitest';
import { spreadWorkers } from './spread.js';

const accounts = (...names: string[]) => names.map((name) => ({ name }));

describe('spreading workers across accounts', () => {
  it('reaches for a healthy account no other session is using first', () => {
    const order = accounts('best', 'second', 'third');
    const inUse = (name: string) => name === 'best';
    const out = spreadWorkers(order, inUse, () => true);
    expect(out.map((a) => a.name)).toEqual(['second', 'third', 'best']);
  });

  it('keeps the pick order within each group', () => {
    const order = accounts('a', 'b', 'c', 'd');
    const inUse = (name: string) => name === 'a' || name === 'c';
    expect(spreadWorkers(order, inUse, () => true).map((a) => a.name)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('never puts a free but nearly spent account ahead of a healthy busy one', () => {
    const order = accounts('busy-healthy', 'free-spent');
    const out = spreadWorkers(
      order,
      (name) => name === 'busy-healthy',
      (name) => name === 'busy-healthy',
    );
    expect(out.map((a) => a.name)).toEqual(['busy-healthy', 'free-spent']);
  });

  it('changes nothing when no other session is running', () => {
    const order = accounts('a', 'b', 'c');
    expect(spreadWorkers(order, () => false, () => true)).toEqual(order);
  });
});
