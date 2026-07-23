import { describe, it, expect } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('package', () => {
  it('exposes its name', () => {
    expect(PACKAGE_NAME).toBe('claude-auto-switch');
  });
});
