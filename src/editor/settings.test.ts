import { describe, it, expect } from 'vitest';
import { editorSettingsPath, setWrapperSetting, clearWrapperSetting, WRAPPER_KEY } from './settings.js';

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
