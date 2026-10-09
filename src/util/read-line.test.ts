import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { readOneLine } from './read-line.js';

describe('readOneLine', () => {
  it('returns the first line, trimmed', async () => {
    const input = new PassThrough();
    const line = readOneLine(5_000, input);
    input.write('  abc#def  \nsecond\n');
    expect(await line).toBe('abc#def');
  });

  it('returns null when input ends before a line arrives', async () => {
    const input = new PassThrough();
    const line = readOneLine(5_000, input);
    input.end();
    expect(await line).toBeNull();
  });

  it('returns null when the wait runs out', async () => {
    const started = Date.now();
    expect(await readOneLine(50, new PassThrough())).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('treats an empty line as no answer', async () => {
    const input = new PassThrough();
    const line = readOneLine(5_000, input);
    input.write('\n');
    expect(await line).toBeNull();
  });
});
