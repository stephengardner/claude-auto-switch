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

describe('carrying only what a session CHANGED', () => {
  it('does not freeze the settings the user already had', () => {
    // The bug this exists for. What is kept here overrides ~/.claude/settings.json
    // for every session afterwards, so keeping a whole copy froze the user's
    // settings at the moment a session last ended. Editing the real file then
    // did nothing, and the frozen value could not be removed by any normal
    // means: that is how `"tui": "fullscreen"` became unkillable.
    const { ctx, root, claudeSettings } = home();
    writeUserSettings(claudeSettings, {
      tui: 'fullscreen',
      hooks: { PreToolUse: [{ command: 'mine' }] },
      model: 'fable',
    });
    const dir = path.join(root, '4242');
    mkdirSync(dir, { recursive: true });
    // What a session holds: everything of the user's, plus the pin it set.
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        tui: 'fullscreen',
        hooks: { PreToolUse: [{ command: 'mine' }] },
        model: 'fable[1m]',
      }),
      'utf8',
    );

    sweepDeadSessionDirs(ctx, { isAlive: () => false });
    // Only the pin. The user's own settings are theirs to change from now on.
    expect(JSON.parse(readFileSync(keptSettingsPath(ctx), 'utf8'))).toEqual({ model: 'fable[1m]' });
  });

  it('lets a setting the user turns OFF actually turn off', () => {
    // The end of the story above: with the real settings changed to `default`
    // and the session still carrying `fullscreen` from before, the next
    // session must come up on default rather than restoring the old value.
    const { ctx, root, claudeSettings } = home();
    writeUserSettings(claudeSettings, { tui: 'default' });
    const dir = path.join(root, '4343');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ tui: 'default' }), 'utf8');

    sweepDeadSessionDirs(ctx, { isAlive: () => false });
    const kept = JSON.parse(readFileSync(keptSettingsPath(ctx), 'utf8')) as Record<string, unknown>;
    expect('tui' in kept).toBe(false);
  });

  it('still carries a change the user made DURING the session', () => {
    // The other half: a setting changed inside a session is a real choice and
    // has to survive, or /model would stop sticking.
    const { ctx, root, claudeSettings } = home();
    writeUserSettings(claudeSettings, { tui: 'default', model: 'fable' });
    const dir = path.join(root, '4444');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ tui: 'fullscreen', model: 'opus' }),
      'utf8',
    );

    sweepDeadSessionDirs(ctx, { isAlive: () => false });
    expect(JSON.parse(readFileSync(keptSettingsPath(ctx), 'utf8'))).toEqual({
      tui: 'fullscreen',
      model: 'opus',
    });
  });

  it('keeps everything when there are no real settings to compare against', () => {
    // A machine where Claude has never written settings. Nothing is known to be
    // the user's, so nothing can be dropped as redundant.
    const { ctx, root } = home();
    const dir = path.join(root, '4545');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'opus' }), 'utf8');

    sweepDeadSessionDirs(ctx, { isAlive: () => false });
    expect(JSON.parse(readFileSync(keptSettingsPath(ctx), 'utf8'))).toEqual({ model: 'opus' });
  });

  it('does not call a setting changed just because its keys moved', () => {
    // Claude rewrites this file, and nothing promises it writes the keys back
    // in the order it read them. Comparing the serialised text would call an
    // identical object a change and pin it as an override forever, which is
    // the same bug in miniature.
    const { ctx, root, claudeSettings } = home();
    writeUserSettings(claudeSettings, {
      hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'x' }] }] },
      permissions: { allow: ['Bash(ls:*)'], deny: [] },
    });
    const dir = path.join(root, '4747');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        // Same content throughout, every object's keys written in a different
        // order.
        permissions: { deny: [], allow: ['Bash(ls:*)'] },
        hooks: { PreToolUse: [{ hooks: [{ command: 'x', type: 'command' }], matcher: 'Edit' }] },
      }),
      'utf8',
    );

    sweepDeadSessionDirs(ctx, { isAlive: () => false });
    expect(JSON.parse(readFileSync(keptSettingsPath(ctx), 'utf8'))).toEqual({});
  });

  it('DOES notice when an array is reordered, because order is meaning', () => {
    // Hooks run in order, so two lists with the same entries in a different
    // order are two different configurations.
    const { ctx, root, claudeSettings } = home();
    writeUserSettings(claudeSettings, { hooks: { Stop: [{ command: 'a' }, { command: 'b' }] } });
    const dir = path.join(root, '4848');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ command: 'b' }, { command: 'a' }] } }),
      'utf8',
    );

    sweepDeadSessionDirs(ctx, { isAlive: () => false });
    expect(JSON.parse(readFileSync(keptSettingsPath(ctx), 'utf8'))).toEqual({
      hooks: { Stop: [{ command: 'b' }, { command: 'a' }] },
    });
  });

  it('compares by VALUE, so an unchanged nested setting is not carried', () => {
    const { ctx, root, claudeSettings } = home();
    const hooks = { PreToolUse: [{ matcher: 'Edit', hooks: [{ command: 'x' }] }] };
    writeUserSettings(claudeSettings, { hooks });
    const dir = path.join(root, '4646');
    mkdirSync(dir, { recursive: true });
    // Same content, rebuilt object: a reference check would call this changed.
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ hooks: JSON.parse(JSON.stringify(hooks)) as unknown }),
      'utf8',
    );

    sweepDeadSessionDirs(ctx, { isAlive: () => false });
    expect(JSON.parse(readFileSync(keptSettingsPath(ctx), 'utf8'))).toEqual({});
  });
});
