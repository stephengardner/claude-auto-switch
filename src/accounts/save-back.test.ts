import { describe, it, expect } from 'vitest';
import { decideSaveBack } from './save-back.js';

const base = {
  sessionEmail: null as string | null,
  sessionIdentity: null as string | null,
  accountIdentity: null as string | null,
  accountName: 'work',
};

describe('decideSaveBack', () => {
  it('saves when the session is the same account as the profile', () => {
    const d = decideSaveBack({
      ...base,
      sessionEmail: 'me@example.com',
      accountEmail: 'me@example.com',
    });
    expect(d.save).toBe(true);
  });

  it('matches the address case-insensitively', () => {
    const d = decideSaveBack({
      ...base,
      sessionEmail: 'Me@Example.com',
      accountEmail: 'me@example.com',
    });
    expect(d.save).toBe(true);
  });

  it('REFUSES when the session belongs to a different account', () => {
    const d = decideSaveBack({
      ...base,
      sessionEmail: 'other@example.com',
      accountEmail: 'me@example.com',
    });
    expect(d.save).toBe(false);
    if (d.save) throw new Error('unreachable');
    // The message has to name both sides, or the warning is unactionable.
    expect(d.reason).toContain('other@example.com');
    expect(d.reason).toContain('work');
  });

  it('falls back to the fuller identity when neither side has an address', () => {
    expect(
      decideSaveBack({ ...base, sessionIdentity: 'uuid-a', accountIdentity: 'uuid-b' }).save,
    ).toBe(false);
    expect(
      decideSaveBack({ ...base, sessionIdentity: 'uuid-a', accountIdentity: 'uuid-a' }).save,
    ).toBe(true);
  });

  it('still checks when the session has an address but the profile has none', () => {
    // The gap this function was extracted for: the address comparison needs both
    // sides, and the fallback used to be skipped whenever the session HAD an
    // address, so this combination was verified by nothing and wrote through.
    const d = decideSaveBack({
      ...base,
      sessionEmail: 'other@example.com',
      accountEmail: undefined,
      sessionIdentity: 'uuid-other',
      accountIdentity: 'uuid-work',
    });
    expect(d.save).toBe(false);
  });

  it('saves when the profile has no address and the identities agree', () => {
    const d = decideSaveBack({
      ...base,
      sessionEmail: 'me@example.com',
      sessionIdentity: 'uuid-work',
      accountIdentity: 'uuid-work',
    });
    expect(d.save).toBe(true);
  });

  it('BLOCKS a mid-session /login from writing into the wrong profile', () => {
    // The exact reported failure. After /login as someone else, the credential
    // has already changed while the identity file beside it still names the OLD
    // account, so the stale comparison MATCHES and waves the wrong login through.
    // Only the confirmed owner sees the truth.
    const d = decideSaveBack({
      ...base,
      confirmedOwner: 'newperson@example.com', // who the credential really is
      sessionEmail: 'me@example.com', // stale: still the old account
      accountEmail: 'me@example.com', // so this comparison would have passed
    });
    expect(d.save).toBe(false);
    if (d.save) throw new Error('unreachable');
    expect(d.reason).toContain('newperson@example.com');
  });

  it('allows the write when the confirmed owner is the account', () => {
    expect(
      decideSaveBack({
        ...base,
        confirmedOwner: 'me@example.com',
        accountEmail: 'me@example.com',
        sessionEmail: 'stale@example.com', // ignored: the API knows better
      }).save,
    ).toBe(true);
  });

  it('refuses when the owner is known but the account has nothing to check against', () => {
    // Falling through to the stale file comparisons here would defeat the whole
    // point of having asked the API in the first place.
    const d = decideSaveBack({
      ...base,
      confirmedOwner: 'someone@example.com',
      sessionEmail: 'stale@example.com',
      sessionIdentity: 'uuid-a',
      accountIdentity: 'uuid-a', // would have matched and allowed the write
    });
    expect(d.save).toBe(false);
    if (d.save) throw new Error('unreachable');
    expect(d.reason).toContain('no recorded account');
  });

  it('refuses when the owner could not be confirmed at all', () => {
    // Offline, or the token was rejected. Guessing is what caused this.
    expect(
      decideSaveBack({ ...base, confirmedOwner: null, accountEmail: 'me@example.com' }).save,
    ).toBe(false);
  });

  it('REFUSES when it cannot confirm, because that is when /login bites', () => {
    // This allowed the write once, and the operator paid for it: running /login
    // inside a session writes the new credential before Claude updates the
    // identity file beside it, so the check compared a stale identity, found
    // nothing to disagree with, and wrote the NEW account's login into the OLD
    // account's profile. Two profiles then held one account.
    //
    // Refusing loses a refreshed token, which the next sign-in restores.
    // Allowing corrupts the account map and cannot be undone locally.
    expect(decideSaveBack({ ...base }).save).toBe(false);
    expect(decideSaveBack({ ...base, sessionEmail: 'me@example.com' }).save).toBe(false);
    expect(decideSaveBack({ ...base, accountEmail: 'me@example.com' }).save).toBe(false);
    expect(decideSaveBack({ ...base, sessionIdentity: 'uuid-a' }).save).toBe(false);
  });

  it('says why it refused, naming the account', () => {
    const d = decideSaveBack({ ...base });
    if (d.save) throw new Error('unreachable');
    expect(d.reason).toContain('work');
    expect(d.reason).toContain('cannot confirm');
  });
});
