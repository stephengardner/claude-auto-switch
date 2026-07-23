import { describe, it, expect } from 'vitest';
import { classifyIsolation, recommendedMechanism } from './preflight.js';

describe('classifyIsolation', () => {
  it('is isolated when an empty config dir is logged out (Windows/Linux)', () => {
    expect(classifyIsolation({ probeEmptyDirLoggedIn: () => false })).toBe('isolated');
  });

  it('is shared when an empty config dir is still logged in (macOS Keychain)', () => {
    expect(classifyIsolation({ probeEmptyDirLoggedIn: () => true })).toBe('shared');
  });
});

describe('recommendedMechanism', () => {
  it('recommends the junction when isolated', () => {
    expect(recommendedMechanism('isolated')).toBe('junction');
  });

  it('recommends oauth-token rotation when shared', () => {
    expect(recommendedMechanism('shared')).toBe('oauth-token');
  });
});
