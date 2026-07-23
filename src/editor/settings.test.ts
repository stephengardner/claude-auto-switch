import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  editorSettingsPath,
  setWrapperSetting,
  clearWrapperSetting,
  setEnvVar,
  clearEnvVar,
  detectEditors,
  WRAPPER_KEY,
  ENV_KEY,
} from './settings.js';

const win = { platform: 'win32' as const, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } };
const mac = { platform: 'darwin' as const, env: { HOME: '/Users/me' } };
const linux = { platform: 'linux' as const, env: { HOME: '/home/me' } };

describe('editorSettingsPath', () => {
  it('resolves Cursor and VS Code on Windows', () => {
    expect(editorSettingsPath('cursor', win)).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\Cursor\\User\\settings.json',
    );
    expect(editorSettingsPath('vscode', win)).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\Code\\User\\settings.json',
    );
  });

  it('resolves on macOS and Linux', () => {
    expect(editorSettingsPath('cursor', mac)).toBe(
      '/Users/me/Library/Application Support/Cursor/User/settings.json',
    );
    expect(editorSettingsPath('cursor', linux)).toBe('/home/me/.config/Cursor/User/settings.json');
  });
});

describe('wrapper setting merge', () => {
  it('sets the wrapper while preserving other settings', () => {
    const next = setWrapperSetting({ 'editor.fontSize': 14 }, '/path/ccx-claude');
    expect(next[WRAPPER_KEY]).toBe('/path/ccx-claude');
    expect(next['editor.fontSize']).toBe(14);
  });

  it('clears the wrapper while preserving other settings', () => {
    const next = clearWrapperSetting({ [WRAPPER_KEY]: '/x', 'editor.fontSize': 14 });
    expect(next[WRAPPER_KEY]).toBeUndefined();
    expect(next['editor.fontSize']).toBe(14);
  });
});

describe('detectEditors', () => {
  it('reports only editors whose user folder exists', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-det-'));
    const c = { platform: 'linux' as const, env: { HOME: home } };
    expect(detectEditors(c)).toEqual([]);
    mkdirSync(path.dirname(editorSettingsPath('cursor', c)), { recursive: true });
    expect(detectEditors(c)).toEqual(['cursor']);
  });
});

describe('environment variable setting', () => {
  it('sets a variable, preserving other variables and settings', () => {
    const next = setEnvVar(
      { [ENV_KEY]: [{ name: 'FOO', value: '1' }], 'editor.fontSize': 14 },
      'CLAUDE_CONFIG_DIR',
      '/active',
    );
    const arr = next[ENV_KEY] as Array<{ name: string; value: string }>;
    expect(arr).toContainEqual({ name: 'FOO', value: '1' });
    expect(arr).toContainEqual({ name: 'CLAUDE_CONFIG_DIR', value: '/active' });
    expect(next['editor.fontSize']).toBe(14);
  });

  it('replaces an existing variable of the same name', () => {
    const next = setEnvVar({ [ENV_KEY]: [{ name: 'X', value: 'old' }] }, 'X', 'new');
    expect(next[ENV_KEY]).toEqual([{ name: 'X', value: 'new' }]);
  });

  it('clears one variable, keeping the rest', () => {
    const next = clearEnvVar(
      { [ENV_KEY]: [{ name: 'X', value: '1' }, { name: 'Y', value: '2' }] },
      'X',
    );
    expect(next[ENV_KEY]).toEqual([{ name: 'Y', value: '2' }]);
  });
});
