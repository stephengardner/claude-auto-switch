import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, configFilePath, saveConfig } from '../config/config.js';
import { applySetting, configCommand } from './settings.js';
import { SETTINGS, type Setting } from '../dashboard/settings-catalog.js';
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
