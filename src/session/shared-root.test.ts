import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureSharedProjects, ensureSharedUserConfig, mergeUserSettings } from './shared-root.js';
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

  it('lets the real status line win, because ccx manages it there and listens to it', () => {
    // `ccx on` wraps the user's own line in `ccx statusline`, which is how ccx
    // hears which conversation and model a session is on. A session carrying the
    // line from before the wrap used to override it in every later session.
    const { home, sessionDir, c } = setup();
    const ours = { type: 'command', command: 'ccx statusline --wrap "ccstatusline"' };
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: ours }),
      'utf8',
    );
    writeFileSync(
      path.join(sessionDir, 'settings.json'),
      JSON.stringify({
        model: 'pinned',
        statusLine: { type: 'command', command: 'ccstatusline', padding: 0 },
      }),
      'utf8',
    );

    mergeUserSettings(sessionDir, c);
    const merged = JSON.parse(readFileSync(path.join(sessionDir, 'settings.json'), 'utf8'));
    expect(merged.statusLine).toEqual(ours);
    expect(merged.model).toBe('pinned'); // everything else is as it was
  });

  it('keeps a session status line when the real settings have none', () => {
    const { home, sessionDir, c } = setup();
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }), 'utf8');
    const own = { type: 'command', command: 'my-line' };
    writeFileSync(path.join(sessionDir, 'settings.json'), JSON.stringify({ statusLine: own }), 'utf8');

    mergeUserSettings(sessionDir, c);
    const merged = JSON.parse(readFileSync(path.join(sessionDir, 'settings.json'), 'utf8'));
    expect(merged.statusLine).toEqual(own);
  });

  it('is a no-op when the user has no settings file', () => {
    const { sessionDir, c } = setup();
    mergeUserSettings(sessionDir, c);
    expect(existsSync(path.join(sessionDir, 'settings.json'))).toBe(false);
  });
});

describe('ensureSharedUserConfig', () => {
  it('gives a session the user own skills and keybindings, which it used to run without', () => {
    const { home, sessionDir, c } = setup();
    const skills = path.join(home, '.claude', 'skills', 'mine');
    mkdirSync(skills, { recursive: true });
    writeFileSync(path.join(skills, 'SKILL.md'), '---\nname: mine\n---\n', 'utf8');
    writeFileSync(path.join(home, '.claude', 'keybindings.json'), '{"bindings":[]}', 'utf8');

    ensureSharedUserConfig(sessionDir, c);
    expect(lstatSync(path.join(sessionDir, 'skills')).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(sessionDir, 'skills', 'mine', 'SKILL.md'), 'utf8')).toContain('name: mine');
    expect(readFileSync(path.join(sessionDir, 'keybindings.json'), 'utf8')).toBe('{"bindings":[]}');
  });

  it('keeps a skill a session already had, merged into the shared folder', () => {
    const { home, sessionDir, c } = setup();
    // Claude makes skills/synced in its own config folder.
    mkdirSync(path.join(sessionDir, 'skills', 'synced'), { recursive: true });
    writeFileSync(path.join(sessionDir, 'skills', 'synced', 'a.md'), 'synced', 'utf8');

    ensureSharedUserConfig(sessionDir, c);
    expect(readFileSync(path.join(home, '.claude', 'skills', 'synced', 'a.md'), 'utf8')).toBe('synced');
  });

  it('never replaces a file the session already has', () => {
    const { home, sessionDir, c } = setup();
    writeFileSync(path.join(sessionDir, 'CLAUDE.md'), 'session copy', 'utf8');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'user memory', 'utf8');
    ensureSharedUserConfig(sessionDir, c);
    expect(readFileSync(path.join(sessionDir, 'CLAUDE.md'), 'utf8')).toBe('session copy');
  });
});
