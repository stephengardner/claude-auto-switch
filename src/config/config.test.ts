import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configStamp, loadConfig, saveConfig } from './config.js';
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
    expect(cfg.rotation.holdBackAtPercent).toBe(80);
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

describe('the page routing settings', () => {
  it('are both off unless something sets them', () => {
    const cfg = loadConfig({ env: { CLAUDE_AUTO_SWITCH_HOME: seedHome(null) } });
    expect(cfg.artifacts).toEqual({ home: null, updates: 'off' });
  });

  it('load from the file, each alone', () => {
    const home = loadConfig({ env: { CLAUDE_AUTO_SWITCH_HOME: seedHome({ artifacts: { home: 'work' } }) } });
    expect(home.artifacts).toEqual({ home: 'work', updates: 'off' });
    const updates = loadConfig({
      env: { CLAUDE_AUTO_SWITCH_HOME: seedHome({ artifacts: { updates: 'owner' } }) },
    });
    expect(updates.artifacts).toEqual({ home: null, updates: 'owner' });
  });

  it('refuse a value that is neither', () => {
    const bad = seedHome({ artifacts: { updates: 'always' } });
    expect(() => loadConfig({ env: { CLAUDE_AUTO_SWITCH_HOME: bad } })).toThrow(ConfigError);
    const empty = seedHome({ artifacts: { home: '' } });
    expect(() => loadConfig({ env: { CLAUDE_AUTO_SWITCH_HOME: empty } })).toThrow(ConfigError);
  });

  it('can be set for one process from its environment, over the file', () => {
    const cfg = loadConfig({
      env: {
        CLAUDE_AUTO_SWITCH_HOME: seedHome({ artifacts: { home: 'work' } }),
        CAS_ARTIFACTS_HOME: 'personal',
        CAS_ARTIFACTS_UPDATES: 'owner',
      },
    });
    expect(cfg.artifacts).toEqual({ home: 'personal', updates: 'owner' });
  });

  it('turn off from the environment too', () => {
    const cfg = loadConfig({
      env: { CLAUDE_AUTO_SWITCH_HOME: seedHome({ artifacts: { home: 'work' } }), CAS_ARTIFACTS_HOME: 'off' },
    });
    expect(cfg.artifacts.home).toBeNull();
    // Only "off", as when it is typed: "none" can be an account's name.
    const named = loadConfig({ env: { CLAUDE_AUTO_SWITCH_HOME: seedHome(null), CAS_ARTIFACTS_HOME: 'none' } });
    expect(named.artifacts.home).toBe('none');
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

describe('configStamp', () => {
  it('is null with no file, and changes when the file does', () => {
    const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: seedHome(null) } };
    expect(configStamp(ctx)).toBeNull();
    saveConfig({ rotation: { holdBackAtPercent: 90 } }, ctx);
    const first = configStamp(ctx);
    expect(first).not.toBeNull();
    expect(configStamp(ctx)).toBe(first);
    saveConfig({ rotation: { holdBackAtPercent: 85, accountOrder: 'most-room' } }, ctx);
    expect(configStamp(ctx)).not.toBe(first);
  });
});
