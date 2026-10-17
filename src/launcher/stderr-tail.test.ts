import { describe, it, expect } from 'vitest';
import { createStderrTail } from './stderr-tail.js';

/** A debug line as Claude 2.1.302 writes one with --debug-to-stderr. */
const debug = (level: string, message: string): string => `2026-10-17T13:52:00.123Z [${level}] ${message}\n`;

/** `text` handed over in pieces of `size` characters, as reads of a pipe can split it. */
function fed(text: string, size: number, limit?: number): string {
  const tail = createStderrTail(limit);
  for (let at = 0; at < text.length; at += size) tail.add(text.slice(at, at + size));
  return tail.text();
}

describe("what is kept of a Claude's standard error", () => {
  it("keeps Claude's own lines and leaves out its debug lines, at every level", () => {
    const text =
      debug('DEBUG', 'API request with rate limit headers') +
      'a warning of its own\n' +
      debug('VERBOSE', 'rate limited') +
      debug('INFO', 'x') +
      debug('WARN', 'too many requests') +
      debug('ERROR', 'API error (attempt 1/11): 429 rate_limit_error') +
      "You've hit your usage limit\n";
    expect(fed(text, text.length)).toBe("a warning of its own\nYou've hit your usage limit\n");
  });

  it('tells a debug line however the reads split it, one character at a time included', () => {
    const text = `${debug('DEBUG', 'rate limit')}own words\n${debug('ERROR', 'rate limit')}more own words`;
    for (const size of [1, 2, 7, 24, 25, 33, 34, 35, 36]) {
      expect(fed(text, size), `pieces of ${size}`).toBe('own words\nmore own words');
    }
  });

  it('keeps a short line of its own that never ended, and a line that only looks like a debug line', () => {
    expect(fed('Usage limit reached', 4)).toBe('Usage limit reached');
    // Not Claude's form: no milliseconds, or a level it does not write.
    const lookalikes = '2026-10-17T13:52:00Z [DEBUG] one\n2026-10-17T13:52:00.123Z [NOTE] two\n';
    expect(fed(lookalikes, 5)).toBe(lookalikes);
  });

  it('keeps only the end, however long one line of its own runs', () => {
    const long = `${'a'.repeat(10_000)}the end`;
    expect(fed(long, 999, 100)).toBe(`${'a'.repeat(93)}the end`);
    expect(fed(`${debug('DEBUG', 'b'.repeat(10_000))}${long}\n`, 999, 100)).toBe(`${'a'.repeat(92)}the end\n`);
  });
});
