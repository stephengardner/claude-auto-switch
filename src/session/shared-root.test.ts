import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  openSync,
  closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  copyUserSettings,
  ensureSharedProjects,
  ensureSharedUserConfig,
  returnSharedUserFiles,
  sharedDirNames,
} from './shared-root.js';
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

describe('copyUserSettings', () => {
  it('gives a session the real settings exactly, with nothing of its own laid over them', () => {
    // A value laid over the real file is one the user cannot change from it:
    // that is how a ccx session ran on another model than the real settings said.
    const { home, sessionDir, c } = setup();
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    const real = { hooks: { PreToolUse: ['x'] }, model: 'user-model' };
    writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(real), 'utf8');
    writeFileSync(path.join(sessionDir, 'settings.json'), JSON.stringify({ model: 'stale', tui: 'old' }), 'utf8');

    expect(copyUserSettings(sessionDir, c)).toBe(true);
    expect(JSON.parse(readFileSync(path.join(sessionDir, 'settings.json'), 'utf8'))).toEqual(real);
  });

  it('leaves the session alone when the real settings do not parse', () => {
    const { home, sessionDir, c } = setup();
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'settings.json'), '{ "hooks": ', 'utf8');
    writeFileSync(path.join(sessionDir, 'settings.json'), '{"model":"kept"}', 'utf8');

    expect(copyUserSettings(sessionDir, c)).toBe(false);
    expect(readFileSync(path.join(sessionDir, 'settings.json'), 'utf8')).toBe('{"model":"kept"}');
  });

  it('is a no-op when the user has no settings file', () => {
    const { sessionDir, c } = setup();
    expect(copyUserSettings(sessionDir, c)).toBe(false);
    expect(existsSync(path.join(sessionDir, 'settings.json'))).toBe(false);
  });
});

describe('sharedDirNames', () => {
  it('shares every folder of ~/.claude but the backups and the separately shared projects', () => {
    const { home } = setup();
    const root = path.join(home, '.claude');
    for (const name of ['backups', 'projects', 'my-own-folder']) mkdirSync(path.join(root, name), { recursive: true });
    writeFileSync(path.join(root, 'a-file'), 'x', 'utf8');

    const names = sharedDirNames(root);
    // The ones Claude is known to use, even before ~/.claude has them.
    for (const known of ['plugins', 'file-history', 'ide', 'todos', 'skills', 'sessions']) {
      expect(names).toContain(known);
    }
    expect(names).toContain('my-own-folder');
    expect(names).not.toContain('backups');
    expect(names).not.toContain('projects');
    expect(names).not.toContain('a-file');
  });

  it('shares a folder that is itself a link, as a dotfiles setup makes them', () => {
    const { home } = setup();
    const root = path.join(home, '.claude');
    const elsewhere = path.join(home, 'dotfiles', 'hooks');
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(root, { recursive: true });
    symlinkSync(elsewhere, path.join(root, 'hooks'), 'junction');

    expect(sharedDirNames(root)).toContain('hooks');
  });

  it('still names the known folders when there is no ~/.claude yet', () => {
    const { home } = setup();
    expect(sharedDirNames(path.join(home, 'nowhere'))).toContain('file-history');
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

  it("starts from the user's file, never a copy an earlier session left in the folder", () => {
    // A folder that could not be cleared keeps its copy, already handed back
    // or kept aside. Kept as this session's start, it would run on stale
    // memory, then hand that stale copy back over the user's.
    const { home, sessionDir, c } = setup();
    writeFileSync(path.join(sessionDir, 'CLAUDE.md'), 'stale copy', 'utf8');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    const theirs = path.join(home, '.claude', 'CLAUDE.md');
    writeFileSync(theirs, 'user memory', 'utf8');

    ensureSharedUserConfig(sessionDir, c);
    expect(readFileSync(path.join(sessionDir, 'CLAUDE.md'), 'utf8')).toBe('user memory');
    returnSharedUserFiles(sessionDir, c);
    expect(readFileSync(theirs, 'utf8')).toBe('user memory');
  });
});

describe('returnSharedUserFiles', () => {
  const later = (file: string): void => {
    const t = Date.now() / 1000 + 60;
    utimesSync(file, t, t);
  };

  it('hands back an edit only the session held, after an editor replaced the linked file', () => {
    const { home, sessionDir, c } = setup();
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    const theirs = path.join(home, '.claude', 'CLAUDE.md');
    writeFileSync(theirs, 'before', 'utf8');
    ensureSharedUserConfig(sessionDir, c);
    // Saved by writing a new file and renaming it over: the link is broken.
    const mine = path.join(sessionDir, 'CLAUDE.md');
    rmSync(mine);
    writeFileSync(mine, 'edited in the session', 'utf8');
    later(mine);
    returnSharedUserFiles(sessionDir, c);
    expect(readFileSync(theirs, 'utf8')).toBe('edited in the session');
  });

  it('keeps a memory first written inside a session, which was never linked', () => {
    const { home, sessionDir, c } = setup();
    writeFileSync(path.join(sessionDir, 'CLAUDE.md'), 'remember this', 'utf8');
    returnSharedUserFiles(sessionDir, c);
    expect(readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe('remember this');
  });

  it('keeps the session folder when its file can neither be compared, handed back nor kept aside', () => {
    const { home, sessionDir, c } = setup();
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'user memory', 'utf8');
    // Not readable as a file at all: neither compared nor copied anywhere.
    const odd = path.join(sessionDir, 'CLAUDE.md');
    mkdirSync(odd);
    later(odd);
    expect(returnSharedUserFiles(sessionDir, c)).toBe(false);
    expect(readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe('user memory');
  });

  it('leaves the user file alone when it is newer, or the session never changed it', () => {
    const { home, sessionDir, c } = setup();
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    const theirs = path.join(home, '.claude', 'CLAUDE.md');
    writeFileSync(path.join(sessionDir, 'CLAUDE.md'), 'older session copy', 'utf8');
    writeFileSync(theirs, 'edited by hand since', 'utf8');
    later(theirs);
    returnSharedUserFiles(sessionDir, c);
    expect(readFileSync(theirs, 'utf8')).toBe('edited by hand since');
  });

  it("keeps both edits when the session and the user changed the same memory: the user's stays", () => {
    // Judged by what the session started from, not by which file is newer.
    const { home, sessionDir, c } = setup();
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    const theirs = path.join(home, '.claude', 'CLAUDE.md');
    writeFileSync(theirs, 'start', 'utf8');
    ensureSharedUserConfig(sessionDir, c);
    const mine = path.join(sessionDir, 'CLAUDE.md');
    rmSync(mine); // the link broken by a rename-save, then edited in the session
    writeFileSync(mine, 'session edit', 'utf8');
    rmSync(theirs);
    writeFileSync(theirs, 'user edit', 'utf8');
    later(theirs);

    expect(returnSharedUserFiles(sessionDir, c)).toBe(true);
    expect(readFileSync(theirs, 'utf8')).toBe('user edit');
    const rescued = path.join(home, '.claude-auto-switch', 'rescued');
    const kept = readdirSync(rescued).find((name) => name.endsWith('-CLAUDE.md'));
    expect(readFileSync(path.join(rescued, kept ?? ''), 'utf8')).toBe('session edit');
  });

  it('keeps an edit aside, never resurrects the file, when the user deleted it meanwhile', () => {
    const { home, sessionDir, c } = setup();
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    const theirs = path.join(home, '.claude', 'CLAUDE.md');
    writeFileSync(theirs, 'old memory', 'utf8');
    ensureSharedUserConfig(sessionDir, c);
    rmSync(path.join(sessionDir, 'CLAUDE.md'));
    writeFileSync(path.join(sessionDir, 'CLAUDE.md'), 'edited in the session', 'utf8');
    rmSync(theirs);

    expect(returnSharedUserFiles(sessionDir, c)).toBe(true);
    expect(existsSync(theirs)).toBe(false);
    const rescued = path.join(home, '.claude-auto-switch', 'rescued');
    const kept = readdirSync(rescued).find((name) => name.endsWith('-CLAUDE.md'));
    expect(readFileSync(path.join(rescued, kept ?? ''), 'utf8')).toBe('edited in the session');
  });

  it("hands back a memory first written in the session when the user had none", () => {
    const { home, sessionDir, c } = setup();
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    ensureSharedUserConfig(sessionDir, c); // nothing to share: an empty record of the start
    writeFileSync(path.join(sessionDir, 'CLAUDE.md'), 'remember this', 'utf8');

    returnSharedUserFiles(sessionDir, c);
    expect(readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe('remember this');
  });

  it('leaves a memory the user deleted deleted, when the session never touched it', () => {
    const { home, sessionDir, c } = setup();
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    const theirs = path.join(home, '.claude', 'CLAUDE.md');
    writeFileSync(theirs, 'old memory', 'utf8');
    ensureSharedUserConfig(sessionDir, c);
    rmSync(path.join(sessionDir, 'CLAUDE.md'));
    writeFileSync(path.join(sessionDir, 'CLAUDE.md'), 'old memory', 'utf8'); // a copy, as without links
    rmSync(theirs);

    returnSharedUserFiles(sessionDir, c);
    expect(existsSync(theirs)).toBe(false);
  });

  it("adds the prompts only a session's own history holds, after the user's, once", () => {
    // History only grows, so a session whose link broke holds the user's lines
    // plus its own. Newer-wins would drop whichever side was older.
    const { home, sessionDir, c } = setup();
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    const theirs = path.join(home, '.claude', 'history.jsonl');
    writeFileSync(theirs, '{"display":"a"}\n{"display":"b"}\n', 'utf8');
    writeFileSync(path.join(sessionDir, 'history.jsonl'), '{"display":"a"}\n{"display":"s1"}\n{"display":"s2"}\n', 'utf8');

    returnSharedUserFiles(sessionDir, c);
    expect(readFileSync(theirs, 'utf8')).toBe('{"display":"a"}\n{"display":"b"}\n{"display":"s1"}\n{"display":"s2"}\n');
    returnSharedUserFiles(sessionDir, c);
    expect(readFileSync(theirs, 'utf8').match(/s1/g)).toHaveLength(1);
  });

  it('keeps a prompt another Claude writes to the history while the session hands back', () => {
    // Every Claude session appends to ~/.claude/history.jsonl. One that has the
    // file open as the hand-back runs, and writes after it, must still land in
    // the user's history rather than in a copy that was replaced.
    const { home, sessionDir, c } = setup();
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    const theirs = path.join(home, '.claude', 'history.jsonl');
    writeFileSync(theirs, '{"display":"a"}\n', 'utf8');
    writeFileSync(path.join(sessionDir, 'history.jsonl'), '{"display":"a"}\n{"display":"s1"}\n', 'utf8');

    const otherClaude = openSync(theirs, 'a');
    try {
      returnSharedUserFiles(sessionDir, c);
      writeFileSync(otherClaude, '{"display":"elsewhere"}\n');
    } finally {
      closeSync(otherClaude);
    }

    expect(readFileSync(theirs, 'utf8')).toBe(
      '{"display":"a"}\n{"display":"s1"}\n{"display":"elsewhere"}\n',
    );
  });

  it('leaves a history that is still one file with the user alone', () => {
    const { home, sessionDir, c } = setup();
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    const theirs = path.join(home, '.claude', 'history.jsonl');
    writeFileSync(theirs, '{"display":"a"}\n', 'utf8');
    ensureSharedUserConfig(sessionDir, c);

    returnSharedUserFiles(sessionDir, c);
    expect(readFileSync(theirs, 'utf8')).toBe('{"display":"a"}\n');
  });

  it("merges a shared folder the session had of its own into the user's, never over it", () => {
    // /rewind checkpoints made in a session whose link could not be made.
    const { home, sessionDir, c } = setup();
    const real = path.join(home, '.claude', 'file-history', 'conv-1');
    mkdirSync(real, { recursive: true });
    writeFileSync(path.join(real, 'v1'), 'user', 'utf8');
    const own = path.join(sessionDir, 'file-history', 'conv-1');
    mkdirSync(own, { recursive: true });
    writeFileSync(path.join(own, 'v1'), 'session copy', 'utf8');
    writeFileSync(path.join(own, 'v2'), 'only in the session', 'utf8');

    expect(returnSharedUserFiles(sessionDir, c)).toBe(true);
    expect(readFileSync(path.join(real, 'v1'), 'utf8')).toBe('user');
    expect(readFileSync(path.join(real, 'v2'), 'utf8')).toBe('only in the session');
  });
});
