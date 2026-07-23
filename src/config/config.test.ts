import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from './config.js';
import { ConfigError } from '../util/errors.js';

/** Make a throwaway config home, optionally seeding a config.json. */
function seedHome(config: unknown | null): string {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-cfg-'));
  if (config !== null) {
    writeFileSync(path.join(home, 'config.json'), JSON.stringify(config), 'utf8');
  }
  return home;
}

describe('loadConfig', () => {
  it('returns all defaults when no file exists', () => {
    const home = seedHome(null);
    const cfg = loadConfig({ env: { CLAUDE_AUTO_SWITCH_HOME: home } });
    expect(cfg.browser.debugPort).toBe(9222);
    expect(cfg.browser.channel).toBe('chrome');
    expect(cfg.rotation.autoRotateHeadless).toBe(true);
    expect(cfg.rotation.defaultBackoffMinutes).toBe(300);
    expect(cfg.realClaudePath).toBeNull();
    expect(cfg.priorityOrder).toEqual([]);
  });

  it('lets file values override defaults while keeping sibling defaults', () => {
    const home = seedHome({ browser: { debugPort: 9333 } });
    const cfg = loadConfig({ env: { CLAUDE_AUTO_SWITCH_HOME: home } });
    expect(cfg.browser.debugPort).toBe(9333);
    expect(cfg.browser.channel).toBe('chrome');
  });

  it('lets env override the file', () => {
    const home = seedHome({ browser: { debugPort: 9333 } });
    const cfg = loadConfig({
      env: { CLAUDE_AUTO_SWITCH_HOME: home, CAS_BROWSER_DEBUG_PORT: '9444' },
    });
    expect(cfg.browser.debugPort).toBe(9444);
  });

  it('throws ConfigError on an invalid type', () => {
    const home = seedHome({ browser: { debugPort: 'not-a-number' } });
    expect(() => loadConfig({ env: { CLAUDE_AUTO_SWITCH_HOME: home } })).toThrow(ConfigError);
  });
});

describe('saveConfig / loadConfig round trip', () => {
  it('persists values that load back', () => {
    const home = seedHome(null);
    const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
    saveConfig({ browser: { debugPort: 9555, channel: 'chrome' } }, ctx);
    const cfg = loadConfig(ctx);
    expect(cfg.browser.debugPort).toBe(9555);
  });
});
