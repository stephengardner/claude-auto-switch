import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isLaterVersion, newerInstall } from './newer-install.js';

/** An install folder whose package says `version`, written `ageMs` ago. */
function install(version: string, ageMs = 60_000, withCli = true): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cas-newer-'));
  const pkg = path.join(root, 'package.json');
  writeFileSync(pkg, JSON.stringify({ name: 'claude-auto-switch', version }));
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(pkg, t, t);
  if (withCli) {
    mkdirSync(path.join(root, 'dist'), { recursive: true });
    writeFileSync(path.join(root, 'dist', 'cli.js'), '');
  }
  return root;
}

describe('a newer ccx installed under a running one', () => {
  it('compares versions as numbers, not text', () => {
    expect(isLaterVersion('1.53.0', '1.52.9')).toBe(true);
    expect(isLaterVersion('1.10.0', '1.9.0')).toBe(true);
    expect(isLaterVersion('2.0.0', '1.99.99')).toBe(true);
    expect(isLaterVersion('1.52.0', '1.52.0')).toBe(false);
    expect(isLaterVersion('1.51.0', '1.52.0')).toBe(false);
  });

  it('is found once its install has settled, with its entry point in place', () => {
    const root = install('1.53.0');
    expect(newerInstall({ root, running: '1.52.0' })).toEqual({
      version: '1.53.0',
      cli: path.join(root, 'dist', 'cli.js'),
    });
  });

  it('is not started while it is still being written, or without its entry point', () => {
    expect(newerInstall({ root: install('1.53.0', 1_000), running: '1.52.0' })).toBeNull();
    expect(newerInstall({ root: install('1.53.0', 60_000, false), running: '1.52.0' })).toBeNull();
  });

  it('never moves a session to the same version, or an older one', () => {
    expect(newerInstall({ root: install('1.52.0'), running: '1.52.0' })).toBeNull();
    expect(newerInstall({ root: install('1.51.0'), running: '1.52.0' })).toBeNull();
    expect(newerInstall({ root: install('1.53.0'), running: null })).toBeNull();
  });
});
