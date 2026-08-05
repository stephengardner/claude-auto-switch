import { describe, it, expect } from 'vitest';
import { outOfAccountsMessage } from './out-of-accounts.js';

const message = (state: Partial<Parameters<typeof outOfAccountsMessage>[0]>) =>
  outOfAccountsMessage({ capped: [], refused: [], neverSignedIn: [], ...state });

describe('what to say when no account is left to run on', () => {
  it('tells you to wait only when waiting is actually the fix', () => {
    expect(message({ capped: ['a', 'b'] })).toBe(
      'every account has hit its limit; try again after a reset',
    );
  });

  it('never mentions a reset when the problem is a sign-in', () => {
    // The defect this file exists to prevent, on its fourth surface: waiting
    // does not repair a login, so sending someone away to wait is worse than
    // saying nothing.
    const out = message({ refused: ['one', 'two'] });
    expect(out).not.toContain('reset');
    expect(out).toBe('one, two need signing in again. Run: ccx login one');
  });

  it('does not say "again" about an account that has never been signed in', () => {
    // The whole point of keeping this group separate. "Sign in again" sends
    // someone looking for a login they never had.
    const out = message({ neverSignedIn: ['fresh'] });
    expect(out).not.toContain('again');
    expect(out).toBe('fresh is not signed in yet. Run: ccx login fresh');
  });

  it('keeps the two sign-in problems apart when both are present', () => {
    expect(message({ refused: ['old'], neverSignedIn: ['fresh'] })).toBe(
      'old needs signing in again. fresh is not signed in yet. Run: ccx login old',
    );
  });

  it('names a limit and a sign-in together, and says waiting will not fix one', () => {
    expect(message({ capped: ['busy'], refused: ['old'] })).toBe(
      'busy hit a limit. old needs signing in again. A reset will not fix a sign-in. Run: ccx login old',
    );
  });

  it('handles all three at once without losing any of them', () => {
    const out = message({ capped: ['busy'], refused: ['old'], neverSignedIn: ['fresh'] });
    expect(out).toContain('busy hit a limit');
    expect(out).toContain('old needs signing in again');
    expect(out).toContain('fresh is not signed in yet');
    expect(out).toContain('A reset will not fix a sign-in');
    expect(out).toContain('Run: ccx login old');
  });

  it('leaves out the reset caveat when nothing is capped, since nobody is waiting', () => {
    expect(message({ neverSignedIn: ['fresh'] })).not.toContain('A reset will not fix');
  });

  it('reads correctly for one account and for several', () => {
    expect(message({ refused: ['solo'] })).toContain('solo needs signing in again');
    expect(message({ refused: ['a', 'b'] })).toContain('a, b need signing in again');
    expect(message({ neverSignedIn: ['solo'] })).toContain('solo is not signed in yet');
    expect(message({ neverSignedIn: ['a', 'b'] })).toContain('a, b are not signed in yet');
  });

  it('falls back to the limit message when it is handed nothing at all', () => {
    expect(message({})).toBe('every account has hit its limit; try again after a reset');
  });
});
