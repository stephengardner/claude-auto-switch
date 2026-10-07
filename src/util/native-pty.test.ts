import { describe, it, expect } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copyOfNodePty, helpersRunnable, nodePty, type ModeOps } from './native-pty.js';

/** A folder laid out like node-pty's, with a spawn-helper in its prebuilt folder. */
function withHelper(): { dir: string; helper: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-pty-helper-'));
  const folder = path.join(dir, 'prebuilds', `${process.platform}-${process.arch}`);
  mkdirSync(folder, { recursive: true });
  const helper = path.join(folder, 'spawn-helper');
  writeFileSync(helper, 'helper');
  return { dir, helper };
}

/** File modes as a test says they are, and the changes asked for. */
function fakeModes(mode: number, chmodFails = false): ModeOps & { changed: Array<[string, number]> } {
  const changed: Array<[string, number]> = [];
  return {
    changed,
    statSync: () => ({ mode }),
    chmodSync: (file, next) => {
      if (chmodFails) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      changed.push([file, next]);
    },
  };
}

describe("node-pty's terminal helper, which its package ships without permission to run", () => {
  // node-pty 1.1.0 ships prebuilds/darwin-*/spawn-helper as rw-r--r--, and on
  // macOS every terminal is opened by running it: "posix_spawnp failed" on
  // every fresh install, so `claude` did not start at all.
  it('is made runnable by everyone, keeping the rest of its mode', () => {
    const { dir, helper } = withHelper();
    const modes = fakeModes(0o100644);
    expect(helpersRunnable(dir, modes)).toBe(true);
    expect(modes.changed).toEqual([[helper, 0o755]]);
  });

  it('is left alone when it can already run', () => {
    const { dir } = withHelper();
    const modes = fakeModes(0o100755);
    expect(helpersRunnable(dir, modes)).toBe(true);
    expect(modes.changed).toEqual([]);
  });

  it('says so when it cannot be changed, as in an install owned by root', () => {
    const { dir } = withHelper();
    expect(helpersRunnable(dir, fakeModes(0o100644, true))).toBe(false);
  });

  it('needs nothing where there is no helper, as on Linux and Windows', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-pty-helper-'));
    const modes = fakeModes(0o100644);
    expect(helpersRunnable(dir, modes)).toBe(true);
    expect(modes.changed).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('really changes the file', () => {
    const { dir, helper } = withHelper();
    chmodSync(helper, 0o644);
    expect(helpersRunnable(dir)).toBe(true);
    expect(statSync(helper).mode & 0o777).toBe(0o755);
  });

  it('opens a terminal through the loader every part of ccx uses', async () => {
    // The whole point, end to end on whatever machine runs this: a terminal
    // opens and its program runs to the end. On macOS this fails without the
    // permission above.
    const child = nodePty().spawn(process.execPath, ['-e', 'process.exit(7)'], {
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });
    const code = await new Promise<number>((resolve) => child.onExit(({ exitCode }) => resolve(exitCode)));
    expect(code).toBe(7);
  });
});

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
