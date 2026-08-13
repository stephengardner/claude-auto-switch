import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PathCtx } from '../config/paths.js';
import {
  planInstall,
  planRemoval,
  isOurs,
  quoteForWrap,
  readSettings,
  installStatusline,
  removeStatusline,
  settingsPath,
  CCX_COMMAND,
} from './settings-install.js';

describe('planning a status line install', () => {
  it('adds ours when there is no status line yet', () => {
    const plan = planInstall({});
    expect(plan.kind).toBe('installed');
    if (plan.kind !== 'installed') return;
    expect(plan.settings.statusLine).toEqual({ type: 'command', command: 'ccx statusline' });
  });

  it('KEEPS every other setting, because that file holds hooks and permissions', () => {
    // The whole risk of touching ~/.claude/settings.json is here. Losing a
    // user's hooks or permission rules to a status line would be a terrible
    // trade, so the merge is asserted directly rather than assumed.
    const before = {
      hooks: { UserPromptSubmit: [{ command: 'do-a-thing' }] },
      permissions: { allow: ['Bash(ls:*)'] },
      model: 'claude-fable-5',
      somethingCcxHasNeverHeardOf: { nested: [1, 2, 3] },
    };
    const plan = planInstall(before);
    if (plan.kind !== 'installed') throw new Error('expected an install');
    expect(plan.settings.hooks).toEqual(before.hooks);
    expect(plan.settings.permissions).toEqual(before.permissions);
    expect(plan.settings.model).toBe('claude-fable-5');
    expect(plan.settings.somethingCcxHasNeverHeardOf).toEqual({ nested: [1, 2, 3] });
  });

  it('runs an existing status line INSIDE ours instead of replacing it', () => {
    const plan = planInstall({
      statusLine: { type: 'command', command: 'my-prompt --fancy' },
    });
    expect(plan.kind).toBe('wrapped');
    if (plan.kind !== 'wrapped') return;
    const value = plan.settings.statusLine as { command: string };
    expect(value.command).toContain('--wrap');
    expect(value.command).toContain('my-prompt --fancy');
    expect(plan.displaced).toEqual({ type: 'command', command: 'my-prompt --fancy' });
  });

  it('quotes a wrapped command so spaces and quotes survive the shell', () => {
    const plan = planInstall({
      statusLine: { type: 'command', command: 'sh -c "echo $USER"' },
    });
    if (plan.kind !== 'wrapped') throw new Error('expected a wrap');
    const command = (plan.settings.statusLine as { command: string }).command;
    // The inner quotes must be escaped, or the shell ends the argument early
    // and the status line runs something the user never wrote.
    expect(command).toContain('\\"echo');
    expect(quoteForWrap('a"b')).toBe('"a\\"b"');
    expect(quoteForWrap('a$b')).toBe('"a\\$b"');
  });

  it('does nothing when ours is already there', () => {
    expect(planInstall({ statusLine: { type: 'command', command: 'ccx statusline' } }).kind).toBe(
      'already',
    );
    expect(
      planInstall({
        statusLine: { type: 'command', command: 'ccx statusline --wrap "mine"' },
      }).kind,
    ).toBe('already');
  });

  it('treats a status line with no command as empty rather than wrapping nothing', () => {
    expect(planInstall({ statusLine: { type: 'command' } }).kind).toBe('installed');
    expect(planInstall({ statusLine: { type: 'command', command: '  ' } }).kind).toBe('installed');
  });

  it('recognizes ours and only ours', () => {
    expect(isOurs({ command: CCX_COMMAND })).toBe(true);
    expect(isOurs({ command: 'starship prompt' })).toBe(false);
    expect(isOurs('ccx statusline')).toBe(false);
    expect(isOurs(null)).toBe(false);
  });
});

describe('planning a status line removal', () => {
  it('puts back the line that was there before, with all of its fields', () => {
    const original = { type: 'command', command: 'my-prompt', padding: 0 };
    const plan = planRemoval(
      { statusLine: { type: 'command', command: 'ccx statusline --wrap "my-prompt"' } },
      original,
    );
    expect(plan.kind).toBe('restored');
    if (plan.kind !== 'restored') return;
    // Restored from the saved object, not reassembled from the --wrap string,
    // so fields ccx does not know about (padding here) come back too.
    expect(plan.settings.statusLine).toEqual(original);
  });

  it('clears the key when there was nothing before ccx', () => {
    const plan = planRemoval({ statusLine: { type: 'command', command: 'ccx statusline' } });
    expect(plan.kind).toBe('removed');
    if (plan.kind !== 'removed') return;
    expect('statusLine' in plan.settings).toBe(false);
  });

  it('NEVER removes a status line the user set themselves', () => {
    expect(planRemoval({ statusLine: { type: 'command', command: 'starship' } }).kind).toBe(
      'untouched',
    );
    expect(planRemoval({}).kind).toBe('untouched');
  });

  it('leaves the rest of the settings alone on the way out', () => {
    const plan = planRemoval({
      hooks: { thing: 1 },
      statusLine: { type: 'command', command: 'ccx statusline' },
    });
    if (plan.kind !== 'removed') throw new Error('expected a removal');
    expect(plan.settings.hooks).toEqual({ thing: 1 });
  });
});

describe('reading the settings file', () => {
  it('reports a broken file instead of pretending it is empty', () => {
    // Defaulting a malformed file to {} would write over it and take the
    // user's real configuration with it. Refusing is the safe answer.
    const dir = mkdtempSync(path.join(tmpdir(), 'ccx-settings-'));
    const file = path.join(dir, 'settings.json');
    writeFileSync(file, '{ this is not json', 'utf8');
    expect(readSettings(file)).toEqual({ ok: false, reason: 'unreadable' });
    writeFileSync(file, '[1, 2, 3]', 'utf8');
    expect(readSettings(file)).toEqual({ ok: false, reason: 'unreadable' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('treats a missing or blank file as nothing configured yet', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ccx-settings-'));
    expect(readSettings(path.join(dir, 'nope.json'))).toEqual({ ok: true, settings: {} });
    const blank = path.join(dir, 'blank.json');
    writeFileSync(blank, '\n', 'utf8');
    expect(readSettings(blank)).toEqual({ ok: true, settings: {} });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('installing and removing against a real file', () => {
  let home: string;
  let ctx: PathCtx;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ccx-home-'));
    // Home is redirected through the ENVIRONMENT, which is the only lever the
    // path helpers read. Passing some other shape does not fail loudly: it
    // silently falls back to the real home and these tests then rewrite the
    // developer's own ~/.claude/settings.json. Hence the assertion below.
    ctx = { platform: process.platform, env: { ...process.env, USERPROFILE: home, HOME: home } };
    expect(settingsPath(ctx).startsWith(home)).toBe(true);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function settings(): Record<string, unknown> {
    return JSON.parse(readFileSync(settingsPath(ctx), 'utf8')) as Record<string, unknown>;
  }

  it('installs, is idempotent, and comes back out clean', () => {
    expect(installStatusline(ctx).outcome).toBe('installed');
    expect(settings().statusLine).toEqual({ type: 'command', command: 'ccx statusline' });

    // Running `ccx on` twice is normal and must not stack wrappers.
    expect(installStatusline(ctx).outcome).toBe('already');
    expect(settings().statusLine).toEqual({ type: 'command', command: 'ccx statusline' });

    expect(removeStatusline(ctx).outcome).toBe('removed');
    expect('statusLine' in settings()).toBe(false);
  });

  it('round-trips someone else’s status line without damaging their settings', () => {
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(
      settingsPath(ctx),
      JSON.stringify({
        statusLine: { type: 'command', command: 'starship prompt', padding: 0 },
        hooks: { UserPromptSubmit: [{ command: 'keep-me' }] },
      }),
      'utf8',
    );

    expect(installStatusline(ctx).outcome).toBe('wrapped');
    expect((settings().statusLine as { command: string }).command).toContain('starship prompt');
    expect(settings().hooks).toEqual({ UserPromptSubmit: [{ command: 'keep-me' }] });

    expect(removeStatusline(ctx).outcome).toBe('restored');
    expect(settings().statusLine).toEqual({
      type: 'command',
      command: 'starship prompt',
      padding: 0,
    });
    expect(settings().hooks).toEqual({ UserPromptSubmit: [{ command: 'keep-me' }] });
  });

  it('refuses to write over a settings file it cannot parse', () => {
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    const broken = '{ "hooks": [ oops';
    writeFileSync(settingsPath(ctx), broken, 'utf8');

    expect(installStatusline(ctx).outcome).toBe('unreadable');
    expect(readFileSync(settingsPath(ctx), 'utf8')).toBe(broken);
    expect(removeStatusline(ctx).outcome).toBe('unreadable');
    expect(readFileSync(settingsPath(ctx), 'utf8')).toBe(broken);
  });

  it('writes ONLY the statusLine key and its own backup, nothing else under ~/.claude', () => {
    // ccx tells people it does not touch their Claude data. This is the one
    // exception, and it stays one file and one key wide.
    installStatusline(ctx);
    const claudeDir = path.join(home, '.claude');
    expect(readdirSync(claudeDir)).toEqual(['settings.json']);
    expect(Object.keys(settings())).toEqual(['statusLine']);
  });

  it('leaves the user’s own line alone if they replaced ours before turning ccx off', () => {
    installStatusline(ctx);
    const mine = { type: 'command', command: 'my-own-thing' };
    writeFileSync(settingsPath(ctx), JSON.stringify({ statusLine: mine }), 'utf8');
    expect(removeStatusline(ctx).outcome).toBe('untouched');
    expect(settings().statusLine).toEqual(mine);
  });

  it('still removes cleanly when the backup file is gone', () => {
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(
      settingsPath(ctx),
      JSON.stringify({ statusLine: { type: 'command', command: 'old' } }),
      'utf8',
    );
    installStatusline(ctx);
    const backup = path.join(home, '.claude-auto-switch', 'statusline-backup.json');
    expect(existsSync(backup)).toBe(true);
    rmSync(backup, { force: true });
    // Losing the restore point must not leave ccx's command stuck in place.
    expect(removeStatusline(ctx).outcome).toBe('removed');
    expect('statusLine' in settings()).toBe(false);
  });
});
