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

describe('an account that is honestly in two states at once', () => {
  it('names a refused-and-never-signed-in account once, as refused', () => {
    const out = message({ refused: ['same'], neverSignedIn: ['same'] });
    expect(out).toBe('same needs signing in again. Run: ccx login same');
    expect(out).not.toContain('not signed in yet');
  });

  it('names a capped-and-refused account once, as the thing you can act on', () => {
    // Reachable: the last-resort account is picked for having room WITHOUT
    // excluding capped ones, so an account that already hit a limit can then be
    // refused. Announcing both would say "wait" and "go sign in" about one
    // account, and waiting is pointless on one you cannot sign into.
    const out = message({ capped: ['same'], refused: ['same'] });
    expect(out).toBe('same needs signing in again. Run: ccx login same');
    expect(out).not.toContain('hit a limit');
  });

  it('drops the reset caveat when every capped account was really a sign-in problem', () => {
    expect(message({ capped: ['same'], refused: ['same'] })).not.toContain('A reset will not fix');
  });

  it('keeps a genuinely capped account when another one is both', () => {
    const out = message({ capped: ['busy', 'same'], refused: ['same'] });
    expect(out).toContain('busy hit a limit');
    expect(out).toContain('same needs signing in again');
    expect(out).toContain('A reset will not fix a sign-in');
    // Rejects the claim itself, not one way of spelling it: "busy hit a limit.
    // same hit a limit" is the same bug in a different shape.
    expect(out).not.toContain('same hit a limit');
  });

  it('says a repeated name once', () => {
    expect(message({ refused: ['dup', 'dup'] })).toBe('dup needs signing in again. Run: ccx login dup');
    const capped = message({ capped: ['dup', 'dup'], refused: ['x'] });
    expect(capped).toContain('dup hit a limit');
    // Containment cannot tell one "dup" from two, so count them.
    expect(capped.match(/\bdup\b/g)).toHaveLength(1);
  });

  it('reads as singular once duplicates are removed', () => {
    // Two entries, one account: "need" would be wrong.
    expect(message({ neverSignedIn: ['solo', 'solo'] })).toContain('solo is not signed in yet');
  });
});
