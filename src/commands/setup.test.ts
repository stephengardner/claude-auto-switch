import { describe, it, expect } from 'vitest';
import { setupGuidance } from './setup.js';

describe('setupGuidance', () => {
  it('tells a new user to add accounts when there are none', () => {
    const g = setupGuidance(0, false);
    expect(g).toContain('Step 1');
    expect(g).toContain('ccx add');
  });

  it('tells a one-account user to add one more', () => {
    const g = setupGuidance(1, false);
    expect(g).toContain('one more');
    expect(g).toContain('ccx add');
  });

  it('offers run and the shim once there are two accounts and no shim', () => {
    const g = setupGuidance(2, false);
    expect(g).toContain('ccx run');
    expect(g).toContain('ccx on');
    expect(g).toContain('ready');
  });

  it('confirms all-set once the shim is installed', () => {
    const g = setupGuidance(3, true);
    expect(g).toContain('All set');
    expect(g).toContain('claude');
    expect(g).not.toContain('ccx on');
  });
});
