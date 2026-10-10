import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isUsableCredential } from './credential-vault.js';
import { signalLoginChange } from './login-change-signal.js';

const folder = (): string => mkdtempSync(path.join(tmpdir(), 'cas-login-signal-'));
const fileIn = (dir: string): string => path.join(dir, '.credentials.json');

describe('telling a running Claude its login was replaced', () => {
  it('does nothing where the login is the file itself: writing it already changed its time', () => {
    const dir = folder();
    expect(signalLoginChange(dir, { keychainHolds: () => false })).toBe('file');
    expect(existsSync(fileIn(dir))).toBe(false);

    writeFileSync(fileIn(dir), JSON.stringify({ account: 'work' }), 'utf8');
    const before = statSync(fileIn(dir)).mtimeMs;
    expect(signalLoginChange(dir, { keychainHolds: () => false, now: () => new Date(Date.now() + 60_000) })).toBe('file');
    expect(statSync(fileIn(dir)).mtimeMs).toBe(before);
  });

  it('gives Claude a file whose time changed when the login lives in the Keychain and there is no file', () => {
    const dir = folder();
    expect(signalLoginChange(dir, { keychainHolds: () => true })).toBe('keychain');
    expect(readFileSync(fileIn(dir), 'utf8')).toBe('{}');
    // Nothing in it is a login to anything that reads the file.
    expect(isUsableCredential(fileIn(dir))).toBe(false);
    if (process.platform !== 'win32') expect(statSync(fileIn(dir)).mode & 0o077).toBe(0);
  });

  it('moves only the time of a file that is already there, each time it is asked', () => {
    const dir = folder();
    writeFileSync(fileIn(dir), '{"left":"as it was"}', 'utf8');
    const start = Date.now();
    signalLoginChange(dir, { keychainHolds: () => true, now: () => new Date(start + 5_000) });
    const first = statSync(fileIn(dir)).mtimeMs;
    signalLoginChange(dir, { keychainHolds: () => true, now: () => new Date(start + 9_000) });
    const second = statSync(fileIn(dir)).mtimeMs;
    expect(readFileSync(fileIn(dir), 'utf8')).toBe('{"left":"as it was"}');
    expect(Math.round(first)).toBe(start + 5_000);
    expect(Math.round(second)).toBe(start + 9_000);
  });

  it('throws when the time cannot be moved, so nobody goes on as if Claude had noticed', () => {
    // A folder that cannot hold a file: its own path is a file.
    const blocked = path.join(folder(), 'a-file');
    writeFileSync(blocked, '', 'utf8');
    expect(() => signalLoginChange(blocked, { keychainHolds: () => true })).toThrow();
  });
});
