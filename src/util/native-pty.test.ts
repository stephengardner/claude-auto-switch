import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copyOfNodePty } from './native-pty.js';

describe('the copy of node-pty a session loads, so the install is never held', () => {
  it('is complete for this platform, without the debug symbols, and loads', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cas-native-pty-'));
    const copy = copyOfNodePty(root);
    expect(existsSync(path.join(copy, 'package.json'))).toBe(true);
    expect(existsSync(path.join(copy, 'lib', 'index.js'))).toBe(true);
    const prebuilt = path.join(copy, 'prebuilds', `${process.platform}-${process.arch}`);
    if (existsSync(prebuilt)) {
      expect(readdirSync(prebuilt).some((f) => f.endsWith('.node'))).toBe(true);
      expect(readdirSync(prebuilt).some((f) => f.endsWith('.pdb'))).toBe(false);
    }
    const pty = createRequire(import.meta.url)(copy) as { spawn?: unknown };
    expect(typeof pty.spawn).toBe('function');
  });

  it('is made once per version and reused, whoever made it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cas-native-pty-'));
    const first = copyOfNodePty(root);
    expect(copyOfNodePty(root)).toBe(first);
    // Nothing half-made is left beside it.
    expect(readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
