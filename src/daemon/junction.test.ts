import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTarget, isLink, readTarget } from './junction.js';

function base(): string {
  return mkdtempSync(path.join(tmpdir(), 'cas-jx-'));
}

describe('junction', () => {
  it('creates a link that resolves to the target', () => {
    const b = base();
    const a = path.join(b, 'a');
    mkdirSync(a);
    const link = path.join(b, 'active');
    setTarget(link, a);
    expect(isLink(link)).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(a));
    expect(readTarget(link)).not.toBeNull();
  });

  it('flips the link to a new target', () => {
    const b = base();
    const a = path.join(b, 'a');
    const c = path.join(b, 'c');
    mkdirSync(a);
    mkdirSync(c);
    const link = path.join(b, 'active');
    setTarget(link, a);
    setTarget(link, c);
    expect(realpathSync(link)).toBe(realpathSync(c));
  });

  it('refuses to replace a real directory (never clobbers a config folder)', () => {
    const b = base();
    const real = path.join(b, 'real');
    mkdirSync(real);
    expect(() => setTarget(real, path.join(b, 'a'))).toThrow(/refusing/);
  });
});
