import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  installDesktopHooks,
  installedHandoff,
  LIMIT_HOOK,
  planDesktopHooks,
  PROMPT_HOOK,
  readInstalledHandoff,
  withoutDesktopHooks,
} from './hooks.js';
import type { PathCtx } from '../config/paths.js';

/** The user's own hook, which must survive everything ccx does. */
const THEIRS = {
  PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node no-emdashes.js' }] }],
};

describe('the Desktop hooks in the user settings', () => {
  it('adds the limit hook for "limit", and the prompt hook as well for "credits"', () => {
    const limit = planDesktopHooks({ hooks: THEIRS }, 'limit');
    expect(installedHandoff(limit)).toBe('limit');
    const credits = planDesktopHooks({ hooks: THEIRS }, 'credits');
    expect(installedHandoff(credits)).toBe('credits');
    const groups = (credits.hooks as Record<string, Array<{ matcher?: string }>>).StopFailure;
    expect(groups?.[0]?.matcher).toBe('rate_limit|billing_error');
  });

  it('every hook lets anything that is not Claude Desktop skip ccx, without hiding its exit code', () => {
    for (const command of [LIMIT_HOOK, PROMPT_HOOK]) {
      expect(command.startsWith('[ "$CLAUDE_CODE_ENTRYPOINT" != claude-desktop ] || ccx desktop-hook')).toBe(true);
    }
  });

  it('never touches the user own hooks, and puts them back exactly on "off"', () => {
    const on = planDesktopHooks({ model: 'opus', hooks: THEIRS }, 'credits');
    expect((on.hooks as typeof THEIRS).PreToolUse).toEqual(THEIRS.PreToolUse);
    expect(planDesktopHooks(on, 'off')).toEqual({ model: 'opus', hooks: THEIRS });
  });

  it('is idempotent: applying the same choice twice changes nothing', () => {
    const once = planDesktopHooks({}, 'credits');
    expect(planDesktopHooks(once, 'credits')).toEqual(once);
  });

  it('removes only what it emptied, leaving a group the user left empty alone', () => {
    const settings = {
      hooks: {
        Stop: [{ hooks: [] }],
        StopFailure: [{ matcher: 'rate_limit|billing_error', hooks: [{ type: 'command', command: LIMIT_HOOK }] }],
      },
    };
    expect(withoutDesktopHooks(settings)).toEqual({ hooks: { Stop: [{ hooks: [] }] } });
  });

  it('reads as "off" with no hooks at all', () => {
    expect(installedHandoff({})).toBe('off');
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
    const { ctx, file } = home(JSON.stringify({ hooks: THEIRS, permissions: { allow: ['Bash(ls:*)'] } }));
    expect(installDesktopHooks('credits', ctx)).toMatchObject({ ok: true, changed: true });
    expect(readInstalledHandoff(ctx)).toBe('credits');
    expect(installDesktopHooks('credits', ctx)).toMatchObject({ ok: true, changed: false });
    expect(installDesktopHooks('off', ctx)).toMatchObject({ ok: true, changed: true });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ hooks: THEIRS, permissions: { allow: ['Bash(ls:*)'] } });
  });

  it('refuses to rewrite a settings file that does not parse, which holds the user hooks', () => {
    const { ctx, file } = home('{ "hooks": ');
    expect(installDesktopHooks('limit', ctx).ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('{ "hooks": ');
  });
});
