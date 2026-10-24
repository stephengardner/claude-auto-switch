import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { moveFolderLogin, type FolderLoginStore } from './claude-folder.js';

/** A login store that only records what the move asked of it. */
function recordingStore(calls: string[]): FolderLoginStore {
  return {
    *install() {
      calls.push('install');
      return true;
    },
    *scrub() {
      calls.push('scrub');
    },
    *rollback() {
      calls.push('rollback');
    },
    *nudge() {
      return true;
    },
  };
}

/** A home of its own, and a ctx that finds the user's files in it. */
function home(): { home: string; ctx: { env: NodeJS.ProcessEnv } } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-claude-folder-'));
  return { home: dir, ctx: { env: { HOME: dir, USERPROFILE: dir } } };
}

describe("a move of a folder's login", () => {
  it('is rolled back when who the folder says it is cannot be written', () => {
    const { home: root, ctx } = home();
    const dir = path.join(root, 'folder');
    const next = path.join(root, 'B');
    mkdirSync(next, { recursive: true });
    writeFileSync(
      path.join(next, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'b@example.com' }, userID: 'b' }),
    );
    // A folder in the way of the file, so the write of the identity fails while the login goes in.
    mkdirSync(path.join(dir, '.claude.json'), { recursive: true });
    writeFileSync(path.join(dir, '.ccx-base.claude.json'), '{}');
    const calls: string[] = [];

    expect(() =>
      moveFolderLogin(dir, next, ctx, recordingStore(calls), {
        *installed() {
          calls.push('installed');
        },
      }),
    ).toThrow();

    expect(calls).toEqual(['install', 'rollback']);
  });

  const someone = (email: string, id: string) => ({
    hasCompletedOnboarding: true,
    theme: 'dark',
    oauthAccount: { emailAddress: email },
    userID: id,
  });
  for (const [whose, inFolder, inUsers] of [
    ["the last account's", someone('a@example.com', 'a'), null],
    ["the user's own", null, someone('me@example.com', 'me')],
  ] as const) {
    it(`gives a folder none of ${whose} identity when the next account has none of its own`, () => {
      const { home: root, ctx } = home();
      const dir = path.join(root, 'folder');
      mkdirSync(dir, { recursive: true });
      if (inFolder) writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(inFolder));
      if (inUsers) writeFileSync(path.join(root, '.claude.json'), JSON.stringify(inUsers));
      const next = path.join(root, 'B');
      mkdirSync(next, { recursive: true });

      moveFolderLogin(dir, next, ctx, recordingStore([]));

      const state = JSON.parse(readFileSync(path.join(dir, '.claude.json'), 'utf8')) as Record<string, unknown>;
      expect(state).not.toHaveProperty('oauthAccount');
      expect(state).not.toHaveProperty('userID');
      expect(state.theme).toBe('dark');
    });
  }
});
