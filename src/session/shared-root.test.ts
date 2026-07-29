import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureSharedProjects, mergeUserSettings } from './shared-root.js';
import type { PathCtx } from '../config/paths.js';

function setup(): { home: string; sessionDir: string; c: PathCtx } {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-shared-'));
  const sessionDir = path.join(home, '.claude-auto-switch', 'session');
  mkdirSync(sessionDir, { recursive: true });
  return { home, sessionDir, c: { env: { HOME: home, USERPROFILE: home } } };
}

describe('ensureSharedProjects', () => {
  it('links a fresh session projects dir to ~/.claude/projects', () => {
    const { home, sessionDir, c } = setup();
    expect(ensureSharedProjects(sessionDir, c)).toBe(true);
    const link = path.join(sessionDir, 'projects');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // A file written in the real store is visible through the session root.
    const slug = path.join(home, '.claude', 'projects', 'repo-a');
    mkdirSync(slug, { recursive: true });
    writeFileSync(path.join(slug, 'sess-1.jsonl'), 'x', 'utf8');
    expect(existsSync(path.join(link, 'repo-a', 'sess-1.jsonl'))).toBe(true);
  });

  it('migrates an existing real projects dir: links it and merges its content into the shared store', () => {
    const { home, sessionDir, c } = setup();
    // Session root already accumulated its own transcript before the fix.
    const own = path.join(sessionDir, 'projects', 'repo-b');
    mkdirSync(own, { recursive: true });
    writeFileSync(path.join(own, 'ccx-session.jsonl'), 'ccx', 'utf8');
    // The real store has existing history that must not be touched.
    const real = path.join(home, '.claude', 'projects', 'repo-b');
    mkdirSync(real, { recursive: true });
    writeFileSync(path.join(real, 'old-session.jsonl'), 'old', 'utf8');

    expect(ensureSharedProjects(sessionDir, c)).toBe(true);
    const link = path.join(sessionDir, 'projects');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // Both histories are now visible through EITHER root.
    expect(readFileSync(path.join(real, 'ccx-session.jsonl'), 'utf8')).toBe('ccx');
    expect(readFileSync(path.join(link, 'repo-b', 'old-session.jsonl'), 'utf8')).toBe('old');
    // Merge never overwrites an existing file in the shared store.
    expect(readFileSync(path.join(real, 'old-session.jsonl'), 'utf8')).toBe('old');
  });

  it('is idempotent and safe without a resolvable home', () => {
    const { sessionDir, c } = setup();
    expect(ensureSharedProjects(sessionDir, c)).toBe(true);
    expect(ensureSharedProjects(sessionDir, c)).toBe(true); // second run: no-op
    expect(ensureSharedProjects(sessionDir, { env: {} })).toBe(false); // no home: refuses quietly
  });
});

describe('mergeUserSettings', () => {
  it('inherits the user settings with session keys winning on conflict', () => {
    const { home, sessionDir, c } = setup();
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: ['x'] }, model: 'user-model' }),
      'utf8',
    );
    writeFileSync(path.join(sessionDir, 'settings.json'), JSON.stringify({ model: 'pinned' }), 'utf8');

    mergeUserSettings(sessionDir, c);
    const merged = JSON.parse(readFileSync(path.join(sessionDir, 'settings.json'), 'utf8'));
    expect(merged.hooks).toEqual({ PreToolUse: ['x'] }); // user hooks now apply
    expect(merged.model).toBe('pinned'); // session pin wins
  });

  it('is a no-op when the user has no settings file', () => {
    const { sessionDir, c } = setup();
    mergeUserSettings(sessionDir, c);
    expect(existsSync(path.join(sessionDir, 'settings.json'))).toBe(false);
  });
});
