import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  desktopHooksProblem,
  installDesktopHooks,
  installedHandoff,
  planDesktopHooks,
  readInstalledHandoff,
  refreshDesktopHooks,
  withoutDesktopHooks,
} from './hooks.js';
import type { HookProgram } from '../claude/settings-hooks.js';
import type { PathCtx } from '../config/paths.js';

/** The user's own hook, which must survive everything ccx does. */
const THEIRS = {
  PreToolUse: [
    { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node no-emdashes.js' }] },
  ],
};

const PROGRAM: HookProgram = {
  node: 'C:\\Program Files\\nodejs\\node.exe',
  entry: 'C:\\npm\\node_modules\\claude-auto-switch\\dist\\desktop\\hook-entry.js',
};

type Hooks = Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;

describe('the Desktop hooks in the user settings', () => {
  it('adds the limit hook for "limit", and the prompt hook as well for "credits"', () => {
    const limit = planDesktopHooks({ hooks: THEIRS }, 'limit', PROGRAM);
    expect(installedHandoff(limit)).toBe('limit');
    const credits = planDesktopHooks({ hooks: THEIRS }, 'credits', PROGRAM);
    expect(installedHandoff(credits)).toBe('credits');
    expect((credits.hooks as Hooks).StopFailure?.[0]?.matcher).toBe('rate_limit|billing_error');
  });

  it('runs node on the hook entry directly, with no shell to read it differently', () => {
    const hooks = planDesktopHooks({}, 'credits', PROGRAM).hooks as Hooks;
    // Git Bash and PowerShell read any one shell test differently; a program
    // and its arguments mean the same thing to both, and to sh on macOS.
    expect(hooks.StopFailure?.[0]?.hooks[0]).toEqual({
      type: 'command',
      command: PROGRAM.node,
      args: [PROGRAM.entry, 'limit'],
      timeout: 30,
    });
    expect(hooks.UserPromptSubmit?.[0]?.hooks[0]).toMatchObject({
      command: PROGRAM.node,
      args: [PROGRAM.entry, 'prompt'],
    });
  });

  it('never touches the user own hooks, and puts them back exactly on "off"', () => {
    const on = planDesktopHooks({ model: 'opus', hooks: THEIRS }, 'credits', PROGRAM);
    expect((on.hooks as typeof THEIRS).PreToolUse).toEqual(THEIRS.PreToolUse);
    expect(planDesktopHooks(on, 'off', PROGRAM)).toEqual({ model: 'opus', hooks: THEIRS });
  });

  it('is idempotent: applying the same choice twice changes nothing', () => {
    const once = planDesktopHooks({}, 'credits', PROGRAM);
    expect(planDesktopHooks(once, 'credits', PROGRAM)).toEqual(once);
  });

  it('replaces the hooks of a ccx installed somewhere else, rather than adding a second set', () => {
    const old = planDesktopHooks({}, 'credits', {
      node: '/usr/bin/node',
      entry: '/old/lib/node_modules/claude-auto-switch/dist/desktop/hook-entry.js',
    });
    const now = planDesktopHooks(old, 'credits', PROGRAM).hooks as Hooks;
    expect(now.StopFailure).toHaveLength(1);
    expect(now.StopFailure?.[0]?.hooks[0]?.command).toBe(PROGRAM.node);
  });

  it('removes only what it emptied, leaving a group the user left empty alone', () => {
    const settings = {
      hooks: {
        Stop: [{ hooks: [] }],
        ...(planDesktopHooks({}, 'limit', PROGRAM).hooks as Hooks),
      },
    };
    expect(withoutDesktopHooks(settings)).toEqual({ hooks: { Stop: [{ hooks: [] }] } });
  });

  it('reads as "off" with no hooks at all', () => {
    expect(installedHandoff({})).toBe('off');
  });

  it('says when the node or the ccx they run is gone, which breaks every session', () => {
    const settings = planDesktopHooks({}, 'limit', PROGRAM);
    expect(desktopHooksProblem(settings, () => true)).toBeNull();
    expect(desktopHooksProblem(settings, (f) => f !== PROGRAM.entry)).toMatch(
      /ccx they run is gone/,
    );
    expect(desktopHooksProblem(settings, (f) => f !== PROGRAM.node)).toMatch(
      /node they run is gone/,
    );
    expect(desktopHooksProblem({}, () => false)).toBeNull();
  });
});

describe('writing them', () => {
  function home(settings?: string): { ctx: PathCtx; file: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-desk-hooks-'));
    const file = path.join(dir, '.claude', 'settings.json');
    if (settings !== undefined) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, settings, 'utf8');
    }
    return { ctx: { env: { HOME: dir, USERPROFILE: dir } }, file };
  }

  it('installs and removes them in the real settings file, keeping everything else', () => {
    const { ctx, file } = home(
      JSON.stringify({ hooks: THEIRS, permissions: { allow: ['Bash(ls:*)'] } }),
    );
    expect(installDesktopHooks('credits', ctx, PROGRAM)).toMatchObject({ ok: true, changed: true });
    expect(readInstalledHandoff(ctx)).toBe('credits');
    expect(installDesktopHooks('credits', ctx, PROGRAM)).toMatchObject({
      ok: true,
      changed: false,
    });
    expect(installDesktopHooks('off', ctx, PROGRAM)).toMatchObject({ ok: true, changed: true });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      hooks: THEIRS,
      permissions: { allow: ['Bash(ls:*)'] },
    });
  });

  it('refuses to rewrite a settings file that does not parse, which holds the user hooks', () => {
    const { ctx, file } = home('{ "hooks": ');
    expect(installDesktopHooks('limit', ctx, PROGRAM).ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('{ "hooks": ');
  });

  it('follows ccx to where it is now, and does nothing when none are wanted or there', () => {
    const { ctx, file } = home(JSON.stringify({ hooks: THEIRS }));
    expect(refreshDesktopHooks('off', ctx, PROGRAM)).toBeNull();
    installDesktopHooks('limit', ctx, { node: 'old-node', entry: '/old/desktop/hook-entry.js' });
    expect(refreshDesktopHooks('limit', ctx, PROGRAM)).toMatchObject({ ok: true, changed: true });
    const hooks = (JSON.parse(readFileSync(file, 'utf8')) as { hooks: Hooks }).hooks;
    expect(hooks.StopFailure?.[0]?.hooks[0]?.args).toEqual([PROGRAM.entry, 'limit']);
    // Chosen off, but still there: taken out.
    expect(refreshDesktopHooks('off', ctx, PROGRAM)).toMatchObject({ ok: true, changed: true });
    expect(readInstalledHandoff(ctx)).toBe('off');
  });
});

describe('the hook entry Claude runs in every session', () => {
  const entry = fileURLToPath(new URL('./hook-entry.ts', import.meta.url));
  const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));

  it('ends at once, and quietly, in a session that is not Desktop', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-hook-entry-'));
    const result = spawnSync(process.execPath, [tsx, entry, 'prompt'], {
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 'x', prompt: 'hello' }),
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli', HOME: dir, USERPROFILE: dir },
      timeout: 60_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('in Desktop, reaches the hook and lets the turn through when the handoff is off', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-hook-entry-'));
    const result = spawnSync(process.execPath, [tsx, entry, 'limit'], {
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 'x', cwd: dir, error: 'rate_limit' }),
      env: {
        ...process.env,
        CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
        CLAUDE_AUTO_SWITCH_HOME: dir,
        HOME: dir,
        USERPROFILE: dir,
      },
      timeout: 60_000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
