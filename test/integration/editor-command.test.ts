import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addCommand } from '../../src/commands/add.js';
import { useCommand } from '../../src/commands/use.js';
import { editorCommand } from '../../src/commands/editor.js';
import { writeFileSync } from 'node:fs';
import { editorSettingsPath, ENV_KEY } from '../../src/editor/settings.js';
import { editorJunctionPath, editorTargetAccount } from '../../src/editor/junction.js';
import { loadConfig } from '../../src/config/config.js';
import type { CliContext } from '../../src/context.js';

function makeContext(home: string): CliContext {
  // HOME/APPDATA both point at the temp home so the editor settings path resolves
  // on any OS; no platform override so the pointer uses the runner's native kind.
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, APPDATA: home } };
  return { ctx, config: loadConfig(ctx), out: () => {}, err: () => {}, json: false, quiet: false };
}

describe('ccx editor on/off (env-var approach)', () => {
  it('points the editor at the active account and reverses cleanly', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-edcmd-'));
    const context = makeContext(home);
    const dirA = path.join(home, 'profiles', 'A');
    await addCommand(context, 'A', { dir: dirA, login: false });
    writeFileSync(path.join(dirA, '.credentials.json'), '{}', 'utf8'); // A is logged in
    useCommand(context, 'A');

    expect(editorCommand(context, 'on')).toBe(0);

    // The pointer resolves to account A, and doctor can name it.
    expect(editorTargetAccount(context)).toEqual({ name: 'A', loggedIn: true });

    // The editor settings now inject CLAUDE_CONFIG_DIR = the ccx pointer.
    const settings = JSON.parse(readFileSync(editorSettingsPath('cursor', context.ctx), 'utf8'));
    const envVars = settings[ENV_KEY] as Array<{ name: string; value: string }>;
    const junction = editorJunctionPath(context);
    expect(envVars).toContainEqual({ name: 'CLAUDE_CONFIG_DIR', value: junction });

    // The pointer exists (a link) and resolves to account A.
    expect(existsSync(junction)).toBe(true);
    expect(lstatSync(junction).isSymbolicLink()).toBe(true);

    // Off removes the injected variable.
    expect(editorCommand(context, 'off')).toBe(0);
    const after = JSON.parse(readFileSync(editorSettingsPath('cursor', context.ctx), 'utf8'));
    expect((after[ENV_KEY] as unknown[]) ?? []).toHaveLength(0);
  });

  it('refuses when there is no active account', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-edcmd-'));
    expect(editorCommand(makeContext(home), 'on')).toBe(1);
  });
});
