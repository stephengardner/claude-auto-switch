import { describe, it, expect, beforeEach } from 'vitest';
import {
  alreadyRefused,
  refusalReason,
  rememberRefused,
  forgetRefusals,
} from './dead-login-memo.js';

describe('remembering a login that cannot be renewed', () => {
  beforeEach(() => forgetRefusals());

  it('knows nothing until something is recorded', () => {
    expect(alreadyRefused('abc')).toBe(false);
    expect(refusalReason('abc')).toBeUndefined();
  });

  it('remembers a refusal against the credential it belongs to', () => {
    rememberRefused('abc', 'token endpoint 400: invalid_grant');
    expect(alreadyRefused('abc')).toBe(true);
    expect(refusalReason('abc')).toContain('invalid_grant');
  });

  it('does NOT apply a refusal to a different credential', () => {
    // The whole point of keying on the credential's contents: signing in again
    // produces different contents, so the old refusal must not follow it.
    rememberRefused('dead-token', 'invalid_grant');
    expect(alreadyRefused('fresh-token')).toBe(false);
  });

  it('treats an unreadable credential as never refused', () => {
    // A null fingerprint means we could not identify the credential, and
    // guessing "already dead" would refuse to renew a login that is fine.
    rememberRefused(null, 'invalid_grant');
    expect(alreadyRefused(null)).toBe(false);
    expect(refusalReason(null)).toBeUndefined();
  });

  it('keeps the reason so it can be reported once rather than every check', () => {
    rememberRefused('abc', 'token endpoint 400: invalid_grant');
    rememberRefused('abc', 'token endpoint 400: invalid_grant');
    expect(refusalReason('abc')).toBe('token endpoint 400: invalid_grant');
  });
});
