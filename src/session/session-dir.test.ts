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
  retireKeptSettings,
  retireLeftoverSessionDir,
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
function home(): { ctx: PathCtx; root: string; claudeSettings: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-sess-'));
  // HOME and USERPROFILE as well as the config home: preserving a session's
  // changes now compares them against the user's REAL settings, and a context
  // that left the home variables alone would read the developer's own file.
  const ctx: PathCtx = {
    env: { CLAUDE_AUTO_SWITCH_HOME: dir, HOME: dir, USERPROFILE: dir },
  };
  return { ctx, root: path.join(dir, 'sessions'), claudeSettings: path.join(dir, '.claude', 'settings.json') };
}

/** Write the user's real Claude settings inside a sandbox. */
function writeUserSettings(file: string, settings: Record<string, unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings), 'utf8');
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

  it('clears out a folder a dead process with this pid left, handing back its changes', () => {
    // The sweep cannot see it: the pid it is named for is alive again, as the
    // session starting now. What it holds belongs to that dead process.
    const { ctx, root, claudeSettings } = home();
    writeUserSettings(claudeSettings, { model: 'fable' });
    const dir = seed(root, '4747');
    writeFileSync(path.join(dir, 'claude-report.json'), JSON.stringify({ id: 'theirs' }), 'utf8');
    writeFileSync(path.join(dir, 'resume-prompt.txt'), 'their task', 'utf8');
    writeFileSync(path.join(dir, '.ccx-base.settings.json'), JSON.stringify({ model: 'fable' }), 'utf8');
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'opus' }), 'utf8');

    expect(retireLeftoverSessionDir(dir, ctx)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(JSON.parse(readFileSync(claudeSettings, 'utf8'))).toEqual({ model: 'opus' });
    // Nothing there is a no-op.
    expect(retireLeftoverSessionDir(dir, ctx)).toBe(false);
  });

  it('will not take over a leftover folder holding an edit it could not save anywhere', () => {
    const { ctx, root } = home();
    const dir = seed(root, '4848');
    // A CLAUDE.md that cannot be read as a file: neither handed back nor kept aside.
    mkdirSync(path.join(dir, 'CLAUDE.md'));
    expect(() => retireLeftoverSessionDir(dir, ctx)).toThrow(/could not be saved/);
    expect(existsSync(dir)).toBe(true);
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

describe("retiring ccx's old store of session settings", () => {
  function store(ctx: PathCtx, settings: Record<string, unknown>): void {
    mkdirSync(path.dirname(keptSettingsPath(ctx)), { recursive: true });
    writeFileSync(keptSettingsPath(ctx), JSON.stringify(settings), 'utf8');
  }

  it('fills only what the real settings lack, so a value set by hand wins', () => {
    // The store was laid over the real file in every ccx session. A machine ran
    // opus and fullscreen in ccx while its real settings said fable and
    // default, and editing the real file changed nothing in ccx.
    const { ctx, claudeSettings } = home();
    writeUserSettings(claudeSettings, { model: 'fable[1m]', tui: 'default', hooks: { Stop: [] } });
    store(ctx, {
      model: 'opus[1m]',
      tui: 'fullscreen',
      modelSettings: { opus: { effortLevel: 'xhigh' } },
    });

    retireKeptSettings(ctx);
    expect(JSON.parse(readFileSync(claudeSettings, 'utf8'))).toEqual({
      model: 'fable[1m]',
      tui: 'default',
      hooks: { Stop: [] },
      modelSettings: { opus: { effortLevel: 'xhigh' } },
    });
    // Renamed aside, never deleted, and never read again.
    expect(existsSync(keptSettingsPath(ctx))).toBe(false);
    expect(JSON.parse(readFileSync(`${keptSettingsPath(ctx)}.retired`, 'utf8'))).toMatchObject({
      model: 'opus[1m]',
    });
  });

  it('creates the real settings from it when there are none', () => {
    const { ctx, claudeSettings } = home();
    store(ctx, { model: 'opus' });
    retireKeptSettings(ctx);
    expect(JSON.parse(readFileSync(claudeSettings, 'utf8'))).toEqual({ model: 'opus' });
  });

  it('never rewrites real settings that do not parse, and waits for them', () => {
    const { ctx, claudeSettings } = home();
    mkdirSync(path.dirname(claudeSettings), { recursive: true });
    writeFileSync(claudeSettings, '{ "hooks": ', 'utf8');
    store(ctx, { model: 'opus' });

    retireKeptSettings(ctx);
    expect(readFileSync(claudeSettings, 'utf8')).toBe('{ "hooks": ');
    expect(existsSync(keptSettingsPath(ctx))).toBe(true);
  });

  it('does nothing without a store', () => {
    const { ctx, claudeSettings } = home();
    writeUserSettings(claudeSettings, { model: 'fable' });
    retireKeptSettings(ctx);
    expect(JSON.parse(readFileSync(claudeSettings, 'utf8'))).toEqual({ model: 'fable' });
    expect(existsSync(`${keptSettingsPath(ctx)}.retired`)).toBe(false);
  });
});

describe("handing back a dead session's changes", () => {
  it('puts a /model choice from a killed session into the real settings', () => {
    // A session killed before it could hand back: the sweep does it instead.
    const { ctx, root, claudeSettings } = home();
    writeUserSettings(claudeSettings, { model: 'fable', tui: 'default' });
    const dir = path.join(root, '1234');
    mkdirSync(dir, { recursive: true });
    // As the session started, then as Claude left it.
    writeFileSync(
      path.join(dir, '.ccx-base.settings.json'),
      JSON.stringify({ model: 'fable', tui: 'default' }),
      'utf8',
    );
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'opus', tui: 'default' }), 'utf8');

    sweepDeadSessionDirs(ctx, { isAlive: () => false });
    expect(existsSync(dir)).toBe(false);
    expect(JSON.parse(readFileSync(claudeSettings, 'utf8'))).toEqual({ model: 'opus', tui: 'default' });
  });

  it('only fills what the real settings lack from a folder with no record of its start', () => {
    // What an older ccx leaves: it laid its store over the real file, so the
    // folder differs from the real settings in values nobody changed in it.
    const { ctx, root, claudeSettings } = home();
    writeUserSettings(claudeSettings, { model: 'fable', tui: 'default' });
    const dir = path.join(root, '4242');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ model: 'opus', tui: 'fullscreen', switchModelsOnFlag: false }),
      'utf8',
    );

    sweepDeadSessionDirs(ctx, { isAlive: () => false });
    expect(JSON.parse(readFileSync(claudeSettings, 'utf8'))).toEqual({
      model: 'fable',
      tui: 'default',
      switchModelsOnFlag: false,
    });
  });
});

