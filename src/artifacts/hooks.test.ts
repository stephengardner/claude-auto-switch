import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  artifactHooksInstalled,
  artifactHooksProblem,
  installArtifactHooks,
  planArtifactHooks,
  refreshArtifactHooks,
  withoutArtifactHooks,
} from './hooks.js';
import { planDesktopHooks } from '../desktop/hooks.js';
import type { HookProgram } from '../claude/settings-hooks.js';
import type { PathCtx } from '../config/paths.js';

/** The user's own hooks, one of them on the very tool ccx hooks, which must survive everything. */
const THEIRS = {
  PreToolUse: [
    { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node no-emdashes.js' }] },
    { matcher: 'Artifact', hooks: [{ type: 'command', command: 'node my-artifact-audit.js' }] },
  ],
};

const PROGRAM: HookProgram = {
  node: 'C:\\Program Files\\nodejs\\node.exe',
  entry: 'C:\\npm\\node_modules\\claude-auto-switch\\dist\\artifacts\\hook-entry.js',
};

type Hooks = Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;

function home(): { ctx: PathCtx; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-artifact-hooks-'));
  mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return {
    ctx: { env: { HOME: dir, USERPROFILE: dir, CLAUDE_AUTO_SWITCH_HOME: path.join(dir, 'ccx') } },
    file: path.join(dir, '.claude', 'settings.json'),
  };
}

describe('the Artifact hooks in the user settings', () => {
  it('hooks the Artifact tool before, after, after a failure, and after each batch of calls, and nothing else', () => {
    const hooks = planArtifactHooks({}, true, PROGRAM).hooks as Hooks;
    expect(Object.keys(hooks).sort()).toEqual(['PostToolBatch', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse']);
    // A batch event takes no matcher: Claude runs it after every batch.
    expect(hooks.PostToolBatch).toHaveLength(1);
    expect(hooks.PostToolBatch?.[0]?.matcher).toBeUndefined();
    expect(hooks.PostToolBatch?.[0]?.hooks[0]).toMatchObject({ command: PROGRAM.node, args: [PROGRAM.entry, 'batch'] });
    for (const [event, word] of [
      ['PreToolUse', 'pre'],
      ['PostToolUse', 'post'],
      ['PostToolUseFailure', 'fail'],
    ] as const) {
      expect(hooks[event]).toHaveLength(1);
      expect(hooks[event]?.[0]?.matcher).toBe('Artifact');
      // A program and its arguments, with no shell to read it differently.
      expect(hooks[event]?.[0]?.hooks[0]).toMatchObject({
        type: 'command',
        command: PROGRAM.node,
        args: [PROGRAM.entry, word],
      });
      expect(typeof hooks[event]?.[0]?.hooks[0]?.timeout).toBe('number');
    }
  });

  it('adds nothing at all while routing is off', () => {
    expect(planArtifactHooks({}, false, PROGRAM)).toEqual({});
    expect(planArtifactHooks({ model: 'opus', hooks: THEIRS }, false, PROGRAM)).toEqual({
      model: 'opus',
      hooks: THEIRS,
    });
  });

  it('never touches the user own hooks, and puts the settings back exactly when turned off', () => {
    const on = planArtifactHooks({ model: 'opus', hooks: THEIRS }, true, PROGRAM);
    expect((on.hooks as typeof THEIRS).PreToolUse.slice(0, 2)).toEqual(THEIRS.PreToolUse);
    expect(planArtifactHooks(on, false, PROGRAM)).toEqual({ model: 'opus', hooks: THEIRS });
    expect(withoutArtifactHooks(on)).toEqual({ model: 'opus', hooks: THEIRS });
  });

  it('is idempotent: turning it on twice changes nothing', () => {
    const once = planArtifactHooks({ hooks: THEIRS }, true, PROGRAM);
    expect(planArtifactHooks(once, true, PROGRAM)).toEqual(once);
  });

  it('replaces the hooks of a ccx installed somewhere else, rather than adding a second set', () => {
    const old = planArtifactHooks({}, true, {
      node: '/usr/bin/node',
      entry: '/old/lib/node_modules/claude-auto-switch/dist/artifacts/hook-entry.js',
    });
    const now = planArtifactHooks(old, true, PROGRAM).hooks as Hooks;
    expect(now.PreToolUse).toHaveLength(1);
    expect(now.PreToolUse?.[0]?.hooks[0]?.command).toBe(PROGRAM.node);
  });

  it('leaves the Desktop hooks alone, and they leave these alone', () => {
    const desktopProgram = { node: PROGRAM.node, entry: PROGRAM.entry.replace('artifacts', 'desktop') };
    const both = planArtifactHooks(planDesktopHooks({}, 'credits', desktopProgram), true, PROGRAM);
    expect(Object.keys(both.hooks as Hooks).sort()).toEqual([
      'PostToolBatch',
      'PostToolUse',
      'PostToolUseFailure',
      'PreToolUse',
      'StopFailure',
      'UserPromptSubmit',
    ]);
    expect(Object.keys(withoutArtifactHooks(both).hooks as Hooks).sort()).toEqual(['StopFailure', 'UserPromptSubmit']);
    const desktopOff = planDesktopHooks(both, 'off', desktopProgram);
    expect(artifactHooksInstalled(desktopOff)).toBe(true);
  });

  it('counts as installed only when all three are there', () => {
    const on = planArtifactHooks({}, true, PROGRAM);
    expect(artifactHooksInstalled(on)).toBe(true);
    expect(artifactHooksInstalled({})).toBe(false);
    const hooks = { ...(on.hooks as Hooks) };
    delete hooks.PostToolUse;
    expect(artifactHooksInstalled({ hooks })).toBe(false);
  });

  it('says why the installed hooks cannot run, when the node or the ccx they name is gone', () => {
    const on = planArtifactHooks({}, true, PROGRAM);
    expect(artifactHooksProblem(on, () => true)).toBeNull();
    expect(artifactHooksProblem(on, (file) => file !== PROGRAM.node)).toContain('node');
    expect(artifactHooksProblem(on, (file) => file !== PROGRAM.entry)).toContain('ccx');
    expect(artifactHooksProblem({}, () => false)).toBeNull();
  });
});

describe('writing them to the settings file', () => {
  it('installs into a settings file that does not exist yet, and removes them again without leaving a trace', () => {
    const { ctx, file } = home();
    expect(installArtifactHooks(true, ctx, PROGRAM)).toEqual({ ok: true, changed: true, file });
    const written = JSON.parse(readFileSync(file, 'utf8')) as { hooks: Hooks };
    expect(written.hooks.PreToolUse?.[0]?.matcher).toBe('Artifact');
    expect(installArtifactHooks(true, ctx, PROGRAM)).toEqual({ ok: true, changed: false, file });
    expect(installArtifactHooks(false, ctx, PROGRAM)).toEqual({ ok: true, changed: true, file });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({});
  });

  it('keeps everything else in the file as it was', () => {
    const { ctx, file } = home();
    const before = { model: 'opus', permissions: { allow: ['Bash(ls:*)'] }, hooks: THEIRS };
    writeFileSync(file, JSON.stringify(before), 'utf8');
    installArtifactHooks(true, ctx, PROGRAM);
    installArtifactHooks(false, ctx, PROGRAM);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(before);
  });

  it('never rewrites a settings file that does not parse', () => {
    const { ctx, file } = home();
    writeFileSync(file, '{ "hooks": ', 'utf8');
    const result = installArtifactHooks(true, ctx, PROGRAM);
    expect(result.ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('{ "hooks": ');
  });

  it('with routing off and nothing installed, touches nothing: no file is created', () => {
    const { ctx, file } = home();
    expect(refreshArtifactHooks(false, ctx, PROGRAM)).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('follows the choice on a refresh: points old hooks at this ccx, and removes them once routing is off', () => {
    const { ctx, file } = home();
    installArtifactHooks(true, ctx, { node: 'old-node', entry: '/old/artifacts/hook-entry.js' });
    expect(refreshArtifactHooks(true, ctx, PROGRAM)).toMatchObject({ ok: true, changed: true });
    const moved = JSON.parse(readFileSync(file, 'utf8')) as { hooks: Hooks };
    expect(moved.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe(PROGRAM.node);
    expect(refreshArtifactHooks(false, ctx, PROGRAM)).toMatchObject({ ok: true, changed: true });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({});
  });
});
