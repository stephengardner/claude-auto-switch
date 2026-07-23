import { describe, it, expect } from 'vitest';
import { mergeOnboarding } from './editor-ready.js';

describe('mergeOnboarding', () => {
  const account = { oauthAccount: { email: 'a@b.com' }, userID: 'u123' };
  const reference = { hasCompletedOnboarding: true, theme: 'dark', hasSeenTasksHint: true };

  it('preserves the account identity', () => {
    const m = mergeOnboarding(account, reference, '/proj');
    expect(m.oauthAccount).toEqual({ email: 'a@b.com' });
    expect(m.userID).toBe('u123');
  });

  it('marks onboarding complete and carries the user preferences', () => {
    const m = mergeOnboarding(account, reference, '/proj');
    expect(m.hasCompletedOnboarding).toBe(true);
    expect(m.theme).toBe('dark');
    expect(m.hasSeenTasksHint).toBe(true);
  });

  it('marks the current folder trusted', () => {
    const m = mergeOnboarding(account, reference, '/proj');
    const projects = m.projects as Record<string, { hasTrustDialogAccepted?: boolean }>;
    expect(projects['/proj']?.hasTrustDialogAccepted).toBe(true);
  });

  it('forces onboarding complete even if the account said otherwise', () => {
    const m = mergeOnboarding({ ...account, hasCompletedOnboarding: false }, {}, '/proj');
    expect(m.hasCompletedOnboarding).toBe(true);
  });
});
