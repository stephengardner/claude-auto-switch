import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, configFilePath, saveConfig } from '../config/config.js';
import { proactiveCommand } from './proactive-config.js';
import { modelsCommand } from './models-config.js';
import type { CliContext } from '../context.js';

/**
 * A command that changes one setting writes that setting and nothing else.
 *
 * `ccx proactive` and `ccx models` read the env-merged config and wrote all of
 * it back, which baked any temporary CAS_* override into config.json, and every
 * default along with it, so a later version's better default never arrived.
 */

function setup(env: Record<string, string> = {}): { context: CliContext; file: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-config-writes-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, ...env } };
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: 'claude', prefixArgs: [] },
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
  };
  return { context, file: configFilePath(ctx) };
}

const written = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

describe('changing one setting', () => {
  it('ccx proactive writes the percent, not the environment or the defaults', () => {
    const { context, file } = setup({ CAS_BROWSER_DEBUG_PORT: '9999' });
    expect(context.config.browser.debugPort).toBe(9999); // the override is in effect...

    expect(proactiveCommand(context, 'on', { percent: '85' })).toBe(0);
    // ...but only the change reaches the file.
    expect(written(file)).toEqual({ rotation: { proactivePercent: 85 } });
  });

  it('ccx proactive keeps what was already in the file', () => {
    const { context, file } = setup();
    saveConfig({ priorityOrder: ['work'], rotation: { capThresholdPercent: 90 } }, context.ctx);
    expect(proactiveCommand(context, 'off')).toBe(0);
    expect(written(file)).toEqual({
      priorityOrder: ['work'],
      rotation: { capThresholdPercent: 90, proactivePercent: 0 },
    });
  });

  it('ccx models writes the chain it was given and nothing else', () => {
    const { context, file } = setup({ CAS_BROWSER_CHANNEL: 'msedge' });
    expect(modelsCommand(context, ['opus', 'fable'])).toBe(0);
    expect(written(file)).toEqual({ rotation: { modelPreference: ['opus', 'fable'] } });
  });

  it('ccx models --strategy writes the strategy and leaves the chain to its default', () => {
    const { context, file } = setup();
    expect(modelsCommand(context, undefined, { strategy: 'account-first' })).toBe(0);
    expect(written(file)).toEqual({ rotation: { modelStrategy: 'account-first' } });
  });
});
