import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCommand } from '../../src/commands/add.js';
import { runCommand } from '../../src/commands/run.js';
import { setActive } from '../../src/state/active.js';
import { loadConfig } from '../../src/config/config.js';
import type { CliContext } from '../../src/context.js';

/**
 * A ccx session is the user's own Claude but for the account: it starts from
 * their real settings, and what Claude saves during it lands where plain
 * `claude` would have saved it. End to end, through the real session path.
 */

const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));

function makeContext(home: string): CliContext {
  // HOME and USERPROFILE too: the user's real ~/.claude is the test's own.
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  return {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    verifyCap: () => Promise.resolve('allowed' as const),
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
  };
}

async function sandbox(prefix: string): Promise<{ home: string; context: CliContext; runsLog: string }> {
  const home = mkdtempSync(path.join(tmpdir(), prefix));
  const runsLog = path.join(home, 'runs.jsonl');
  process.env.FAKE_CLAUDE_IDLE_MS = '400';
  process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;
  const context = makeContext(home);
  const dir = path.join(home, 'profiles', 'only');
  await addCommand(context, 'only', { dir, login: false });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: 'only' }), 'utf8');
  setActive('only', context.ctx);
  return { home, context, runsLog };
}

const write = (file: string, value: unknown): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value), 'utf8');
};
const read = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
const launches = (runsLog: string): Array<{ settingsModel: string | null }> =>
  readFileSync(runsLog, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { type: string; settingsModel: string | null })
    .filter((e) => e.type === 'launch');

describe('a ccx session is your own Claude but for the account', () => {
  afterEach(() => {
    delete process.env.FAKE_CLAUDE_IDLE_MS;
    delete process.env.FAKE_CLAUDE_RUNS_LOG;
    delete process.env.FAKE_CLAUDE_SET_SETTINGS;
    delete process.env.FAKE_CLAUDE_SET_STATE;
  });

  it('saves a model picked in the session where plain claude would have', async () => {
    const { home, context, runsLog } = await sandbox('cas-thin-model-');
    const settings = path.join(home, '.claude', 'settings.json');
    write(settings, { model: 'fable', hooks: { Stop: [] } });
    process.env.FAKE_CLAUDE_SET_SETTINGS = JSON.stringify({ model: 'opus' });

    expect(await runCommand(context, [])).toBe(0);
    // Started on the user's own model, and the one picked in it was saved.
    expect(launches(runsLog)[0]?.settingsModel).toBe('fable');
    expect(read(settings)).toEqual({ model: 'opus', hooks: { Stop: [] } });
  });

  it("saves a preference set in the session into Claude's own state, never the account", async () => {
    const { home, context } = await sandbox('cas-thin-state-');
    const state = path.join(home, '.claude.json');
    write(state, { hasCompletedOnboarding: true, theme: 'dark' });
    process.env.FAKE_CLAUDE_SET_STATE = JSON.stringify({ theme: 'light' });

    expect(await runCommand(context, [])).toBe(0);
    const saved = read(state);
    expect(saved.theme).toBe('light');
    expect(saved).not.toHaveProperty('oauthAccount');
  });

  it("starts from the real settings, folding ccx's old store in only where they had nothing", async () => {
    // The store used to be laid over the real file: sessions ran another model
    // and screen mode than the real settings said, and editing them did nothing.
    const { home, context, runsLog } = await sandbox('cas-thin-store-');
    const settings = path.join(home, '.claude', 'settings.json');
    write(settings, { model: 'fable[1m]', tui: 'default' });
    write(path.join(home, 'session-settings.json'), { model: 'opus[1m]', tui: 'fullscreen', switchModelsOnFlag: false });

    expect(await runCommand(context, [])).toBe(0);
    expect(launches(runsLog)[0]?.settingsModel).toBe('fable[1m]');
    expect(read(settings)).toEqual({ model: 'fable[1m]', tui: 'default', switchModelsOnFlag: false });
    expect(existsSync(path.join(home, 'session-settings.json'))).toBe(false);
    expect(existsSync(path.join(home, 'session-settings.json.retired'))).toBe(true);
  });
});
