import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, configFilePath, saveConfig } from '../config/config.js';
import { applySetting, configCommand } from './settings.js';
import { SETTINGS, type Setting } from '../dashboard/settings-catalog.js';
import { addAccount } from '../accounts/registry.js';
import type { CliContext } from '../context.js';

function setup(env: Record<string, string> = {}): { context: CliContext; file: string; said: string[] } {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-settings-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, ...env } };
  const said: string[] = [];
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: 'claude', prefixArgs: [] },
    out: (m: string) => said.push(m),
    err: () => {},
    json: false,
    quiet: false,
  };
  return { context, file: configFilePath(ctx), said };
}

const written = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

const setting = (key: string): Setting => SETTINGS.find((s) => s.key === key) as Setting;

describe('changing one setting', () => {
  it('writes that setting and nothing else, never the environment or the defaults', async () => {
    const { context, file } = setup({ CAS_BROWSER_DEBUG_PORT: '9999' });
    saveConfig({ browser: { channel: 'msedge' } }, context.ctx);
    const said = await applySetting(context, setting('rotation.holdBackAtPercent'), 90);
    expect(said).toBe('Hold back weeks used past: 90%');
    expect(written(file)).toEqual({ browser: { channel: 'msedge' }, rotation: { holdBackAtPercent: 90 } });
    // The running config follows, with the environment still in force.
    expect(context.config.rotation.holdBackAtPercent).toBe(90);
    expect(context.config.browser.debugPort).toBe(9999);
  });

  it('refuses a value the config would not load with, and writes nothing', async () => {
    const { context, file } = setup();
    await expect(applySetting(context, setting('rotation.holdBackAtPercent'), 30)).rejects.toThrow(
      'Hold back weeks used past',
    );
    expect(() => readFileSync(file)).toThrow();
  });

  it('changes Desktop settings through ccx desktop, which says what it did', async () => {
    const { context, file } = setup();
    const said = await applySetting(context, setting('desktop.mode'), 'same');
    expect(said).toContain('continues itself');
    expect(written(file)).toEqual({ desktop: { mode: 'same' } });
    expect(context.config.desktop.mode).toBe('same');
  });
});

describe('the page settings', () => {
  /** A home folder for Claude's settings beside the ccx one, and two accounts. */
  function pages(): ReturnType<typeof setup> & { claudeSettings: string } {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-settings-pages-'));
    const made = setup({ HOME: home, USERPROFILE: home });
    for (const name of ['work', 'personal']) {
      addAccount({ name, dir: path.join(home, 'profiles', name) }, made.context.ctx);
    }
    return { ...made, claudeSettings: path.join(home, '.claude', 'settings.json') };
  }
  const hookEvents = (file: string): string[] => {
    try {
      return Object.keys((written(file).hooks ?? {}) as Record<string, unknown>).sort();
    } catch {
      return [];
    }
  };
  const ALL = ['PostToolUse', 'PostToolUseFailure', 'PreToolUse'];

  it('install the hooks when the first one is turned on, and remove them when the last one is turned off', async () => {
    const { context, file, claudeSettings } = pages();
    expect(await applySetting(context, setting('artifacts.home'), 'work')).toContain('Publish new pages as: work');
    expect(written(file)).toEqual({ artifacts: { home: 'work' } });
    expect(context.config.artifacts.home).toBe('work');
    expect(hookEvents(claudeSettings)).toEqual(ALL);

    await applySetting(context, setting('artifacts.updates'), 'owner');
    expect(hookEvents(claudeSettings)).toEqual(ALL);

    // One of the two is still on.
    await applySetting(context, setting('artifacts.home'), null);
    expect(written(file)).toEqual({ artifacts: { home: null, updates: 'owner' } });
    expect(hookEvents(claudeSettings)).toEqual(ALL);

    const off = await applySetting(context, setting('artifacts.updates'), 'off');
    expect(off).toContain('removed');
    expect(written(claudeSettings)).toEqual({});
    expect(context.config.artifacts).toEqual({ home: null, updates: 'off' });
  });

  it('leave the hooks somebody else put there exactly as they were', async () => {
    const { context, claudeSettings } = pages();
    const theirs = { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Artifact', hooks: [{ type: 'command', command: 'audit' }] }] } };
    mkdirSync(path.dirname(claudeSettings), { recursive: true });
    writeFileSync(claudeSettings, JSON.stringify(theirs), 'utf8');
    await applySetting(context, setting('artifacts.updates'), 'owner');
    expect(hookEvents(claudeSettings)).toEqual(ALL);
    await applySetting(context, setting('artifacts.updates'), 'off');
    expect(written(claudeSettings)).toEqual(theirs);
  });

  it('refuse a home account that is not an account, and change nothing', async () => {
    const { context, file, claudeSettings } = pages();
    await expect(applySetting(context, setting('artifacts.home'), 'nobody')).rejects.toThrow('no account called "nobody"');
    expect(() => readFileSync(file)).toThrow();
    expect(() => readFileSync(claudeSettings)).toThrow();
  });

  it('save nothing when the hooks cannot be written, so the setting never says on with nothing behind it', async () => {
    const { context, file, claudeSettings } = pages();
    mkdirSync(path.dirname(claudeSettings), { recursive: true });
    writeFileSync(claudeSettings, '{ broken', 'utf8');
    await expect(applySetting(context, setting('artifacts.home'), 'work')).rejects.toThrow('not valid JSON');
    expect(() => readFileSync(file)).toThrow();
    expect(readFileSync(claudeSettings, 'utf8')).toBe('{ broken');
  });

  it('touch nothing in Claude settings when a setting is put back to off with none installed', async () => {
    const { context, claudeSettings } = pages();
    await applySetting(context, setting('artifacts.updates'), 'off');
    expect(() => readFileSync(claudeSettings)).toThrow();
  });

  it('work from ccx config, by name, with off and default both turning the home account off', async () => {
    const { context, file, said, claudeSettings } = pages();
    expect(await configCommand(context, 'artifacts.home', ['personal'])).toBe(0);
    expect(context.config.artifacts.home).toBe('personal');
    expect(said.join('\n')).toContain('when its Claude next starts');
    expect(await configCommand(context, 'artifacts.home', ['off'])).toBe(0);
    expect(written(file)).toEqual({ artifacts: { home: null } });
    expect(written(claudeSettings)).toEqual({});
    expect(await configCommand(context, 'artifacts.home', ['work'])).toBe(0);
    expect(await configCommand(context, 'artifacts.home', ['default'])).toBe(0);
    expect(context.config.artifacts.home).toBeNull();
    expect(await configCommand(context, 'artifacts.home', ['no body'])).toBe(1);
    expect(said.at(-1)).toBe('artifacts.home: an account name, or off');
    expect(await configCommand(context, 'artifacts.home')).toBe(0);
    expect(said.join('\n')).toContain('takes: an account name, or off');
  });
});

describe('ccx config', () => {
  it('lists every setting under its group, with its value in words', async () => {
    const { context, said } = setup();
    expect(await configCommand(context)).toBe(0);
    expect(said).toContain('Picking accounts');
    expect(said.some((l) => /rotation\.accountOrder\s+longest run first/.test(l))).toBe(true);
    expect(said.some((l) => /rotation\.holdBackAtPercent\s+80%/.test(l))).toBe(true);
  });

  it('explains one setting: what it does, when it applies, what it takes', async () => {
    const { context, said } = setup();
    expect(await configCommand(context, 'holdBackAtPercent')).toBe(0);
    expect(said[0]).toBe('rotation.holdBackAtPercent: 80%');
    expect(said.join('\n')).toContain("Takes effect at each session's next move.");
    expect(said.join('\n')).toContain('takes: 50 to 99 percent, or off; default: 80%');
  });

  it('changes a setting from typed words, and puts the default back on "default"', async () => {
    const { context, file, said } = setup();
    expect(await configCommand(context, 'rotation.accountOrder', ['fastest'])).toBe(1);
    // The words the screen shows work as well as the name.
    expect(await configCommand(context, 'rotation.accountOrder', ['most', 'room'])).toBe(0);
    expect(written(file)).toEqual({ rotation: { accountOrder: 'most-room' } });
    expect(await configCommand(context, 'resume.prompt', ['Keep', 'going.'])).toBe(0);
    expect(context.config.resume.prompt).toBe('Keep going.');
    expect(await configCommand(context, 'accountOrder', ['default'])).toBe(0);
    expect(context.config.rotation.accountOrder).toBe('smart');
    expect(said.at(-1)).toBe("Takes effect at each session's next move.");
  });

  it('says what is wrong with a name or a value, and fails', async () => {
    const { context, said } = setup();
    expect(await configCommand(context, 'nonsense')).toBe(1);
    expect(said.at(-1)).toContain('ccx config lists them');
    expect(await configCommand(context, 'prompt', ['hi'])).toBe(1);
    expect(said.at(-1)).toBe('"prompt" could be resume.prompt or desktop.prompt');
    expect(await configCommand(context, 'update.follow', ['sometimes'])).toBe(1);
    expect(said.at(-1)).toBe('update.follow: say on or off');
  });
});
