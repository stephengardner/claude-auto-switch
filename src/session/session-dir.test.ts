import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PathCtx } from '../config/paths.js';
import {
  sessionsRoot,
  sessionDirFor,
  isSessionDir,
  pidOfSessionDir,
  sweepDeadSessionDirs,
  removeSessionDir,
  keptSettingsPath,
  seedFromKeptSettings,
} from './session-dir.js';

/**
 * One shared session directory is what let two sessions swap logins behind each
 * other's backs, which is how three accounts here ended up as one. These check
 * the directories stay apart, and that cleaning one up can never reach through
 * the junction into the user's real transcripts.
 */

/**
 * A throwaway config home. Pointed there by the env override every other test
 * here uses: these functions DELETE directories, so one that resolved to the
 * real config home would sweep the operator's live sessions.
 */
function home(): { ctx: PathCtx; root: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-sess-'));
  return { ctx: { env: { CLAUDE_AUTO_SWITCH_HOME: dir } }, root: path.join(dir, 'sessions') };
}

describe('a directory per session', () => {
  it('gives two sessions different directories', () => {
    const { ctx } = home();
    expect(sessionDirFor(111, ctx)).not.toEqual(sessionDirFor(222, ctx));
    expect(path.dirname(sessionDirFor(111, ctx))).toEqual(sessionsRoot(ctx));
  });

  it('recognises a session directory, and the pre-split single one', () => {
    const { ctx } = home();
    expect(isSessionDir(sessionDirFor(111, ctx), ctx)).toBe(true);
    // A session started before the upgrade is still running in the old one.
    expect(isSessionDir(path.join(path.dirname(sessionsRoot(ctx)), 'session'), ctx)).toBe(true);
    expect(isSessionDir(path.join(sessionDirFor(111, ctx), 'projects'), ctx)).toBe(false);
    expect(isSessionDir(path.join(path.dirname(sessionsRoot(ctx)), 'profiles', 'main'), ctx)).toBe(false);
  });

  it('reads the pid out of a directory name, and refuses anything else', () => {
    expect(pidOfSessionDir('4321')).toBe(4321);
    expect(pidOfSessionDir('0')).toBeNull();
    expect(pidOfSessionDir('not-a-pid')).toBeNull();
    expect(pidOfSessionDir('12x')).toBeNull();
  });
});

describe('sweeping session directories left behind', () => {
  function seed(root: string, name: string): string {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.credentials.json'), '{}', 'utf8');
    return dir;
  }

  it('removes the ones whose session is gone and keeps the live ones', () => {
    const { ctx, root } = home();
    seed(root, '111');
    seed(root, '222');
    seed(root, 'not-a-pid');
    const removed = sweepDeadSessionDirs(ctx, { isAlive: (pid) => pid === 222 });
    expect(removed).toEqual(['111']);
    expect(existsSync(path.join(root, '111'))).toBe(false);
    expect(existsSync(path.join(root, '222'))).toBe(true);
    // Not ours to judge, so left alone rather than deleted on a guess.
    expect(existsSync(path.join(root, 'not-a-pid'))).toBe(true);
  });

  it('never sweeps the session doing the sweeping', () => {
    const { ctx, root } = home();
    seed(root, '333');
    // Even with a liveness check that says it is dead, which is what a pid
    // reused by the OS would look like.
    expect(sweepDeadSessionDirs(ctx, { isAlive: () => false, keepPid: 333 })).toEqual([]);
    expect(existsSync(path.join(root, '333'))).toBe(true);
  });

  it('says nothing happened when no session has ever run', () => {
    const { ctx } = home();
    expect(sweepDeadSessionDirs(ctx, { isAlive: () => false })).toEqual([]);
  });
});

describe('deleting a session directory', () => {
  it('unlinks the projects junction instead of deleting the real transcripts', () => {
    // The single most destructive thing in this file. `projects` points at the
    // user's real ~/.claude/projects: every transcript, every project memory.
    // A recursive delete that followed it would take all of it.
    const { root } = home();
    const realProjects = path.join(path.dirname(root), 'REAL-projects');
    mkdirSync(realProjects, { recursive: true });
    writeFileSync(path.join(realProjects, 'a-transcript.jsonl'), 'precious', 'utf8');

    const dir = path.join(root, '999');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.credentials.json'), '{}', 'utf8');
    symlinkSync(realProjects, path.join(dir, 'projects'), 'junction');

    expect(removeSessionDir(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(path.join(realProjects, 'a-transcript.jsonl'))).toBe(true);
    expect(readdirSync(realProjects)).toEqual(['a-transcript.jsonl']);
  });
});

describe('carrying the model pin between sessions', () => {
  it('seeds a fresh session from what the last one ended with', () => {
    const { ctx, root } = home();
    mkdirSync(path.dirname(keptSettingsPath(ctx)), { recursive: true });
    writeFileSync(keptSettingsPath(ctx), JSON.stringify({ model: 'opus' }), 'utf8');
    const dir = path.join(root, '777');
    mkdirSync(dir, { recursive: true });

    expect(seedFromKeptSettings(dir, ctx)).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8'))).toEqual({ model: 'opus' });
  });

  it('falls back to the pre-split directory, so an upgrade does not lose the pin', () => {
    const { ctx, root } = home();
    const legacy = path.join(path.dirname(root), 'session');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, 'settings.json'), JSON.stringify({ model: 'fable' }), 'utf8');
    const dir = path.join(root, '888');
    mkdirSync(dir, { recursive: true });

    expect(seedFromKeptSettings(dir, ctx)).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8'))).toEqual({ model: 'fable' });
  });

  it('never overwrites settings a session already has', () => {
    const { ctx, root } = home();
    mkdirSync(path.dirname(keptSettingsPath(ctx)), { recursive: true });
    writeFileSync(keptSettingsPath(ctx), JSON.stringify({ model: 'opus' }), 'utf8');
    const dir = path.join(root, '999');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'mine' }), 'utf8');

    expect(seedFromKeptSettings(dir, ctx)).toBe(false);
    expect(JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8'))).toEqual({ model: 'mine' });
  });

  it('keeps the pin when the session directory is swept', () => {
    const { ctx, root } = home();
    const dir = path.join(root, '1234');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'sonnet' }), 'utf8');

    sweepDeadSessionDirs(ctx, { isAlive: () => false });
    expect(existsSync(dir)).toBe(false);
    expect(JSON.parse(readFileSync(keptSettingsPath(ctx), 'utf8'))).toEqual({ model: 'sonnet' });
  });
});
