import { describe, it, expect } from 'vitest';
import { assertProfileName, isInside, assertInsideProfiles } from './names.js';
import { InvalidNameError } from './errors.js';

describe('assertProfileName', () => {
  it('accepts normal names', () => {
    expect(() => assertProfileName('work-max')).not.toThrow();
    expect(() => assertProfileName('personal.2')).not.toThrow();
  });

  it('rejects traversal, separators, and absolute-ish names', () => {
    for (const bad of ['..', '.', '../x', 'a/b', 'a\\b', 'C:', 'a:b', '-flag', '']) {
      expect(() => assertProfileName(bad), bad).toThrow(InvalidNameError);
    }
  });

  it('rejects Windows reserved device names', () => {
    for (const bad of ['CON', 'nul', 'PRN', 'com1', 'lpt9']) {
      expect(() => assertProfileName(bad), bad).toThrow(InvalidNameError);
    }
  });

  it('rejects names over 64 chars', () => {
    expect(() => assertProfileName('a'.repeat(65))).toThrow(InvalidNameError);
  });
});

describe('isInside / assertInsideProfiles', () => {
  it('is true only for paths strictly inside the root', () => {
    expect(isInside('/root/profiles', '/root/profiles/work')).toBe(true);
    expect(isInside('/root/profiles', '/root/profiles')).toBe(false);
    expect(isInside('/root/profiles', '/root/other')).toBe(false);
    expect(isInside('/root/profiles', '/root/profiles/../../etc')).toBe(false);
  });

  it('throws when a dir escapes the profiles root', () => {
    expect(() => assertInsideProfiles('/root/profiles', '/etc/passwd')).toThrow(InvalidNameError);
    expect(() => assertInsideProfiles('/root/profiles', '/root/profiles/ok')).not.toThrow();
  });
});
