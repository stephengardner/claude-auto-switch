import { describe, it, expect } from 'vitest';
import { thrownReason } from './onoff.js';

/**
 * Setting up an editor reaches outside the process, and anything at all can be
 * thrown. This handler exists to keep `ccx on` alive, so it must not be the
 * thing that ends it.
 */
describe('reading a reason out of whatever was thrown', () => {
  it('uses an Error message', () => {
    expect(thrownReason(new Error('profile is read-only'))).toBe('profile is read-only');
  });

  it('handles a thrown string, which an `as Error` cast prints as undefined', () => {
    expect(thrownReason('EPERM')).toBe('EPERM');
  });

  it('handles a thrown null, which an `as Error` cast turns into a TypeError', () => {
    expect(thrownReason(null)).toBe('no reason given');
    expect(thrownReason(undefined)).toBe('no reason given');
  });

  it('says something useful for an Error with nothing to say, or a bare object', () => {
    expect(thrownReason(new Error(''))).toBe('no reason given');
    expect(thrownReason({})).toBe('no reason given');
  });
});
