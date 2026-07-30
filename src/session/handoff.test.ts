import { describe, it, expect } from 'vitest';
import { activateWithLease, finishWithLease } from './handoff.js';

/** Records every step in the order it happened, which is what is under test. */
function recorder(installThrows = false) {
  const calls: string[] = [];
  return {
    calls,
    steps: {
      takeLease: (a: string) => calls.push(`take:${a}`),
      releaseLease: (a: string) => calls.push(`release:${a}`),
      install: () => {
        calls.push('install');
        if (installThrows) throw new Error('credential copy failed');
      },
      saveBack: () => calls.push('saveBack'),
    },
  };
}

describe('activateWithLease', () => {
  it('announces the account BEFORE copying its login in', () => {
    // The gap between copying and announcing is a window where a renewer can
    // retire the token the session is about to start on.
    const r = recorder();
    activateWithLease('A', null, r.steps);
    expect(r.calls).toEqual(['take:A', 'install']);
    expect(r.calls.indexOf('take:A')).toBeLessThan(r.calls.indexOf('install'));
  });

  it('releases the previous account only AFTER the switch succeeds', () => {
    const r = recorder();
    const now = activateWithLease('B', 'A', r.steps);
    expect(r.calls).toEqual(['take:B', 'install', 'release:A']);
    expect(now).toBe('B');
  });

  it('gives the new announcement back if the switch fails', () => {
    const r = recorder(true);
    expect(() => activateWithLease('B', 'A', r.steps)).toThrow(/copy failed/);
    // B is not in use after all, and A is still protected because the session is
    // still on it.
    expect(r.calls).toEqual(['take:B', 'install', 'release:B']);
    expect(r.calls).not.toContain('release:A');
  });

  it('does not release the account it is re-activating', () => {
    // Re-activating the same account must not drop its protection, even briefly.
    const r = recorder();
    activateWithLease('A', 'A', r.steps);
    expect(r.calls).toEqual(['take:A', 'install']);
  });

  it('keeps protecting the account when re-activating it fails', () => {
    const r = recorder(true);
    expect(() => activateWithLease('A', 'A', r.steps)).toThrow();
    expect(r.calls).not.toContain('release:A'); // still on it, still protected
  });
});

describe('finishWithLease', () => {
  it('saves the login back BEFORE dropping the announcement', () => {
    // The other order lets a renewer rotate the profile and then have the save
    // overwrite it with the session's older token, destroying the renewed login.
    const r = recorder();
    finishWithLease('A', r.steps);
    expect(r.calls).toEqual(['saveBack', 'release:A']);
    expect(r.calls.indexOf('saveBack')).toBeLessThan(r.calls.indexOf('release:A'));
  });

  it('still saves when there is nothing announced', () => {
    const r = recorder();
    finishWithLease(null, r.steps);
    expect(r.calls).toEqual(['saveBack']);
  });
});
