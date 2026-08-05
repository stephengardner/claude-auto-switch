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
import { rememberDeadLogin } from '../../src/usage/dead-login-store.js';
import { credentialFileFingerprint } from '../../src/accounts/credential-vault.js';
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
    // A REAL login. This used to be '{}' with a comment claiming it was logged
    // in, which the old check believed because the file existed. A signed-out
    // profile keeps a complete credential with empty tokens, so file presence
    // was never the question.
    writeFileSync(
      path.join(dirA, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-a', refreshToken: 'r' } }),
      'utf8',
    );
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

describe('what the editor pointer reports about the account it resolves to', () => {
  it('does not call a signed-OUT profile logged in', async () => {
    // The shape that used to pass: a complete credential file whose tokens are
    // empty, which is exactly what Claude leaves behind when a profile signs
    // out. Judging by the file existing reported it as a working account.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-edout-'));
    const context = makeContext(home);
    const dir = path.join(home, 'profiles', 'empty');
    await addCommand(context, 'empty', { dir, login: false });
    writeFileSync(path.join(dir, '.credentials.json'), '{}', 'utf8');
    useCommand(context, 'empty');
    expect(editorCommand(context, 'on')).toBe(0);

    expect(editorTargetAccount(context)).toEqual({ name: 'empty', loggedIn: false });
  });

  it('does not call a REFUSED login logged in either', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-edref-'));
    const context = makeContext(home);
    const dir = path.join(home, 'profiles', 'refused');
    await addCommand(context, 'refused', { dir, login: false });
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-x', refreshToken: 'r' } }),
      'utf8',
    );
    useCommand(context, 'refused');
    expect(editorCommand(context, 'on')).toBe(0);
    rememberDeadLogin(credentialFileFingerprint(dir), 'token endpoint 400: invalid_grant', context.ctx);

    expect(editorTargetAccount(context)).toEqual({ name: 'refused', loggedIn: false });
  });
});
