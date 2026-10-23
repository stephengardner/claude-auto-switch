import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { moveFolderLogin, type FolderLoginStore } from './claude-folder.js';

describe("a move of a folder's login", () => {
  it('is rolled back when who the folder says it is cannot be written', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-claude-folder-'));
    const dir = path.join(home, 'folder');
    const next = path.join(home, 'B');
    mkdirSync(next, { recursive: true });
    writeFileSync(
      path.join(next, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'b@example.com' }, userID: 'b' }),
    );
    // A folder in the way of the file, so the write of the identity fails while the login goes in.
    mkdirSync(path.join(dir, '.claude.json'), { recursive: true });
    writeFileSync(path.join(dir, '.ccx-base.claude.json'), '{}');
    const calls: string[] = [];
    const store: FolderLoginStore = {
      install: () => {
        calls.push('install');
        return true;
      },
      scrub: () => void calls.push('scrub'),
      rollback: () => void calls.push('rollback'),
      nudge: () => true,
    };

    expect(() =>
      moveFolderLogin(dir, next, { env: { HOME: home, USERPROFILE: home } }, store, {
        installed: () => void calls.push('installed'),
      }),
    ).toThrow();

    expect(calls).toEqual(['install', 'rollback']);
  });
});
