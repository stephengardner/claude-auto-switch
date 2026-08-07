import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { capProbeCredential } from './cap-probe-credential.js';

describe('capProbeCredential', () => {
  const SESSION = path.join('/home', '.claude-auto-switch', 'session', '.credentials.json');

  it('asks the ACCOUNT being capped, never the shared session directory', () => {
    // The whole bug. The session directory is shared between concurrent runs, so
    // it holds whichever account another run installed last. Asking it let an
    // exhausted account answer for a healthy one, and the healthy one took a
    // five-hour cap it had not earned.
    const chosen = capProbeCredential('/home/.claude-auto-switch/profiles/second', SESSION);
    expect(chosen).toBe(path.join('/home/.claude-auto-switch/profiles/second', '.credentials.json'));
    expect(chosen).not.toBe(SESSION);
  });

  it('gives each account a different answer', () => {
    // A verdict that cannot tell two accounts apart is how one account's
    // exhaustion spread across all of them in 87 seconds.
    const a = capProbeCredential('/p/second', SESSION);
    const b = capProbeCredential('/p/main', SESSION);
    expect(a).not.toBe(b);
  });

  it('falls back to the session credential only when no account is chosen yet', () => {
    // Before an account is picked nothing can be capped, so there is no wrong
    // account to answer for.
    for (const empty of [null, undefined, '']) {
      expect(capProbeCredential(empty, SESSION)).toBe(SESSION);
    }
  });
});
