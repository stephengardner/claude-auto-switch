import { describe, it, expect } from 'vitest';
import { ensureLoginUsable, readinessMessage, swapMode } from './preflight.js';

function deps(over: Partial<Parameters<typeof ensureLoginUsable>[0]> = {}) {
  return {
    hasLogin: () => true,
    renewalDue: () => false,
    renew: () => Promise.resolve({ status: 'refreshed' }),
    ...over,
  };
}

describe('ensureLoginUsable', () => {
  it('does nothing when the login is fine', async () => {
    let renewed = false;
    const r = await ensureLoginUsable(
      deps({
        renew: () => {
          renewed = true;
          return Promise.resolve({ status: 'refreshed' });
        },
      }),
    );
    expect(r.state).toBe('ready');
    expect(renewed).toBe(false); // nothing to do, so nothing touched
  });

  it('renews an expired login rather than starting a session on it', async () => {
    // The bug this exists for: a login that expired hours ago was copied into a
    // new session and launched, and the first thing on screen was "logged out".
    const r = await ensureLoginUsable(deps({ renewalDue: () => true }));
    expect(r.state).toBe('renewed');
  });

  it('says which account needs signing in when the login is finished', async () => {
    const r = await ensureLoginUsable(
      deps({
        renewalDue: () => true,
        renew: () => Promise.resolve({ status: 'needs-login', detail: 'invalid_grant' }),
      }),
    );
    expect(r.state).toBe('needs-login');
    const message = readinessMessage('main', r);
    expect(message).toContain('main');
    expect(message).toContain('invalid_grant');
    expect(message).toContain('ccx login main'); // the exact command that fixes it
  });

  it('reports a profile with no login at all as needing sign-in', async () => {
    const r = await ensureLoginUsable(deps({ hasLogin: () => false }));
    expect(r.state).toBe('needs-login');
    expect(readinessMessage('work', r)).toContain('ccx login work');
  });

  it('starts anyway when the login cannot be checked', async () => {
    // Being unable to check is not evidence the login is bad. Refusing to start
    // over a network blip would be worse than letting Claude try.
    const r = await ensureLoginUsable(
      deps({
        renewalDue: () => true,
        renew: () => Promise.resolve({ status: 'unavailable', detail: 'offline' }),
      }),
    );
    expect(r.state).toBe('unknown');
    expect(readinessMessage('main', r)).toContain('starting anyway');
  });

  it('survives a renewal that throws', async () => {
    const r = await ensureLoginUsable(
      deps({
        renewalDue: () => true,
        renew: () => Promise.reject(new Error('socket hang up')),
      }),
    );
    expect(r.state).toBe('unknown');
  });

  it('stays quiet when everything is normal', async () => {
    // Announcing routine housekeeping trains people to ignore the line that
    // actually matters.
    expect(readinessMessage('main', { state: 'ready' })).toBeNull();
    expect(readinessMessage('main', { state: 'renewed' })).toBeNull();
  });
});

describe('swapMode', () => {
  it('swaps in place when the target login is usable right now', () => {
    expect(swapMode({ hasLogin: () => true, renewalDue: () => false })).toBe('in-place');
  });

  it('relaunches instead when the target login needs renewing', () => {
    // The swap is synchronous, so nothing can be renewed during it. Swapping an
    // expired login under a running Claude lands it on a dead token, which is the
    // same sudden sign-out the pre-flight exists to prevent. Relaunching with
    // --continue keeps the conversation and lets the start path renew first.
    expect(swapMode({ hasLogin: () => true, renewalDue: () => true })).toBe('restart');
  });

  it('relaunches when the target has no login at all', () => {
    expect(swapMode({ hasLogin: () => false, renewalDue: () => false })).toBe('restart');
  });
});
