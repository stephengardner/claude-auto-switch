import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { shouldHintShim, shimHintText, wasHinted, markHinted } from './shim-hint.js';

describe('shouldHintShim', () => {
  it('hints only when the shim is missing and not yet hinted', () => {
    expect(shouldHintShim(false, false)).toBe(true);
    expect(shouldHintShim(true, false)).toBe(false);
    expect(shouldHintShim(false, true)).toBe(false);
    expect(shouldHintShim(true, true)).toBe(false);
  });
});

describe('shimHintText', () => {
  it('points at ccx on and says it shows once', () => {
    expect(shimHintText()).toContain('ccx on');
    expect(shimHintText()).toContain('once');
  });
});

describe('hinted marker', () => {
  it('is false before marking and true after', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-hint-'));
    expect(wasHinted(home)).toBe(false);
    markHinted(home);
    expect(wasHinted(home)).toBe(true);
  });
});
