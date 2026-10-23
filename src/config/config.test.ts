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

describe('the lending section', () => {
  const at = (config: unknown) => loadConfig({ env: { CLAUDE_AUTO_SWITCH_HOME: seedHome(config) } });

  it('is absent, so lending is off, until config.json has one', () => {
    expect(at({}).lending).toBeUndefined();
  });

  it('takes any number of targets, each with its own transport, accounts and settings', () => {
    const cfg = at({
      lending: {
        renewAheadMinutes: 90,
        expiryMarginMinutes: 10,
        targets: [
          { name: 'build-server', transport: { type: 'ssh', host: 'user@build-1' }, accounts: ['work-a', 'work-b'] },
          { name: 'shared-dir', transport: { type: 'directory', path: '/srv/ccx-lends' }, accounts: 'all' },
          {
            name: 'custom',
            transport: { type: 'command', run: 'my-uploader --stdin' },
            accounts: ['work-c'],
            renewAheadMinutes: 120,
          },
        ],
      },
    });
    expect(cfg.lending?.targets.map((t) => t.name)).toEqual(['build-server', 'shared-dir', 'custom']);
    // The remote command ssh runs defaults to the import.
    expect(cfg.lending?.targets[0]?.transport).toEqual({ type: 'ssh', host: 'user@build-1', remoteCommand: 'ccx lend import' });
    expect(cfg.lending?.targets[2]?.renewAheadMinutes).toBe(120);
  });

  it('fills the defaults a section leaves out', () => {
    expect(at({ lending: {} }).lending).toEqual({ renewAheadMinutes: 90, expiryMarginMinutes: 10, targets: [] });
  });

  it('refuses what would not work, saying where', () => {
    const dir = { type: 'directory', path: '/x' };
    const refusals: Array<[unknown, RegExp]> = [
      [{ targets: [{ name: 'a', transport: dir, accounts: 'all' }, { name: 'a', transport: dir, accounts: 'all' }] }, /two targets are named/],
      [{ targets: [{ name: 'a', transport: { type: 'ssh', host: '-oProxyCommand=x' }, accounts: 'all' }] }, /not a host ssh can be given safely/],
      [{ renewAheadMinutes: 10, expiryMarginMinutes: 10 }, /renewAheadMinutes must be more than expiryMarginMinutes/],
      [{ targets: [{ name: 'a', transport: dir, accounts: 'all', expiryMarginMinutes: 120 }] }, /renewAheadMinutes must be more than expiryMarginMinutes/],
      [{ targets: [{ name: 'a', transport: dir, accounts: [] }] }, /name at least one account/],
      [{ targets: [{ name: 'a', transport: dir, accounts: ['../x'] }] }, /not an account name/],
      [{ targets: [{ name: 'a b', transport: dir, accounts: 'all' }] }, /a target name is/],
      [{ targets: [{ name: 'a', transport: { type: 'carrier-pigeon' }, accounts: 'all' }] }, /Invalid discriminator/],
    ];
    for (const [lending, why] of refusals) {
      expect(() => at({ lending }), why.source).toThrow(why);
    }
  });
});
