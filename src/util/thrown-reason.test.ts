import { describe, it, expect } from 'vitest';
import { thrownReason } from './thrown-reason.js';

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

  it('survives a value whose own toString throws', () => {
    // The failure mode this function exists to prevent, applied to itself: a
    // formatter that throws takes out the handler that was keeping the program
    // alive.
    const hostile = {
      toString() {
        throw new Error('nope');
      },
    };
    expect(() => thrownReason(hostile)).not.toThrow();
    expect(thrownReason(hostile)).toBe('no reason given');
  });

  it('survives a throwing Symbol.toPrimitive too', () => {
    const hostile = {
      [Symbol.toPrimitive]() {
        throw new Error('nope');
      },
    };
    expect(thrownReason(hostile)).toBe('no reason given');
  });
});
