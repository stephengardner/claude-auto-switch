import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
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

  it('refuses to replace a real directory that HAS something in it', () => {
    // The whole point of the guard: a real config folder must never be clobbered.
    const b = base();
    const real = path.join(b, 'real');
    mkdirSync(real);
    writeFileSync(path.join(real, 'settings.json'), '{}', 'utf8');
    expect(() => setTarget(real, path.join(b, 'a'))).toThrow(/refusing/);
  });

  it('replaces an EMPTY real directory, because there is nothing to lose', () => {
    // Left-behind debris, which is what the editor-active pointer had become.
    // Refusing on an empty folder turned harmless debris into a crash that
    // stopped the whole setup command, after the shell shim and status line had
    // already been installed.
    const b = base();
    const target = path.join(b, 'target');
    mkdirSync(target);
    const debris = path.join(b, 'editor-active');
    mkdirSync(debris);
    setTarget(debris, target);
    expect(isLink(debris)).toBe(true);
    expect(realpathSync(debris)).toBe(realpathSync(target));
  });

  it('still refuses a real FILE, and leaves it alone', () => {
    const b = base();
    const file = path.join(b, 'a-file');
    writeFileSync(file, 'data', 'utf8');
    expect(() => setTarget(file, b)).toThrow(/refusing/);
    expect(existsSync(file)).toBe(true);
  });
});
