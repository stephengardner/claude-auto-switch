import { describe, it, expect } from 'vitest';
import { signInFailureNotice } from './sign-in-failure.js';

describe('signInFailureNotice', () => {
  it('names the account and carries the reason', () => {
    const said = signInFailureNotice('phx', new Error('connect ECONNREFUSED 127.0.0.1:9222'));
    expect(said).toContain('"phx"');
    expect(said).toContain('ECONNREFUSED');
  });

  it('still says something useful when what was thrown is not an Error', () => {
    // A rejected promise can carry anything. An empty reason would leave the
    // operator with a dangling colon and nothing to act on.
    for (const thrown of [undefined, null, '', {}, new Error('   ')]) {
      const said = signInFailureNotice('main', thrown);
      expect(said).toContain('"main"');
      expect(said).toContain('no reason given');
      expect(said.trim().endsWith(':')).toBe(false);
    }
  });

  it('prefers a thrown string over the fallback', () => {
    expect(signInFailureNotice('second', 'chrome not found')).toContain('chrome not found');
  });
});
