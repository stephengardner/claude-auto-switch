import { describe, it, expect } from 'vitest';
import { replaceFileSync } from './replace-file.js';

/** A rename that refuses with `code` for the first `failures` attempts. */
function refusing(failures: number, code = 'EPERM') {
  const calls: Array<[string, string]> = [];
  const waits: number[] = [];
  let left = failures;
  const rename = (from: string, to: string): void => {
    calls.push([from, to]);
    if (left > 0) {
      left -= 1;
      throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
    }
  };
  return { calls, waits, rename, wait: (ms: number) => void waits.push(ms) };
}

describe('replacing a file another process may have open', () => {
  it('waits out a brief Windows refusal instead of losing the write', () => {
    // Several ccx processes share the usage snapshot and the active account.
    // Giving up at the first refusal lost the update and left its temp file.
    const r = refusing(3);
    replaceFileSync('t.tmp', 'f.json', 'win32', r.rename, r.wait);
    expect(r.calls).toHaveLength(4);
    expect(r.waits).toEqual([5, 10, 20]);
  });

  it('retries each refusal Windows gives for a held file', () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      const r = refusing(1, code);
      replaceFileSync('t.tmp', 'f.json', 'win32', r.rename, r.wait);
      expect(r.calls).toHaveLength(2);
    }
  });

  it('gives up after about a fifth of a second and reports the refusal', () => {
    const r = refusing(99);
    expect(() => replaceFileSync('t.tmp', 'f.json', 'win32', r.rename, r.wait)).toThrow(/EPERM/);
    expect(r.calls).toHaveLength(6);
    expect(r.waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(200);
  });

  it('does not wait on an error that waiting cannot fix', () => {
    const r = refusing(1, 'ENOENT');
    expect(() => replaceFileSync('t.tmp', 'f.json', 'win32', r.rename, r.wait)).toThrow(/ENOENT/);
    expect(r.waits).toEqual([]);
  });

  it('does not wait elsewhere, where replacing an open file is never refused', () => {
    const r = refusing(1);
    expect(() => replaceFileSync('t.tmp', 'f.json', 'linux', r.rename, r.wait)).toThrow(/EPERM/);
    expect(r.waits).toEqual([]);
  });
});
