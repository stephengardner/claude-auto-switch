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

  it('allows the write when there is nothing to compare', () => {
    // Refusing on unknown would discard a renewed token for every profile with
    // no recorded address, which causes the sign-in prompts this exists to stop.
    expect(decideSaveBack({ ...base }).save).toBe(true);
    expect(decideSaveBack({ ...base, sessionEmail: 'me@example.com' }).save).toBe(true);
  });
});
