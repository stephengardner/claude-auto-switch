import { describe, it, expect } from 'vitest';
import { parseAuthStatus } from './auth-status.js';
import { AuthStatusParseError } from '../util/errors.js';

// Shapes captured from the real CLI during spec verification (facts 1 and 2).
const loggedIn = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'augdog911@gmail.com',
  orgId: 'dd36b940-da06-4d1e-ae81-55e336b874e1',
  orgName: "augdog911@gmail.com's Organization",
  subscriptionType: 'max',
});
const loggedOut = JSON.stringify({
  loggedIn: false,
  authMethod: 'none',
  apiProvider: 'firstParty',
});

describe('parseAuthStatus', () => {
  it('parses a logged-in account (loggedIn is the source of truth)', () => {
    const h = parseAuthStatus(loggedIn);
    expect(h.loggedIn).toBe(true);
    expect(h.email).toBe('augdog911@gmail.com');
    expect(h.plan).toBe('max');
    expect(h.orgName).toContain('Organization');
  });

  it('parses a logged-out account', () => {
    const h = parseAuthStatus(loggedOut);
    expect(h.loggedIn).toBe(false);
    expect(h.email).toBeUndefined();
    expect(h.plan).toBeUndefined();
  });

  it('tolerates surrounding noise around the JSON', () => {
    const noisy = `Some warning line\n${loggedIn}\nTrailing note`;
    expect(parseAuthStatus(noisy).loggedIn).toBe(true);
  });

  it('throws on non-JSON garbage', () => {
    expect(() => parseAuthStatus('not json at all')).toThrow(AuthStatusParseError);
  });

  it('throws when the loggedIn field is missing', () => {
    expect(() => parseAuthStatus(JSON.stringify({ authMethod: 'none' }))).toThrow(
      AuthStatusParseError,
    );
  });
});
