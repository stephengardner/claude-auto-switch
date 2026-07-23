import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installEditorWrapper, uninstallEditorWrapper } from './install.js';
import { editorSettingsPath, WRAPPER_KEY } from './settings.js';

function ctxWithHome(): { platform: 'linux'; env: { HOME: string } } {
  return { platform: 'linux', env: { HOME: mkdtempSync(path.join(tmpdir(), 'cas-ed-')) } };
}

describe('installEditorWrapper', () => {
  it('writes the wrapper into a fresh settings file', () => {
    const c = ctxWithHome();
    const r = installEditorWrapper('cursor', '/bin/ccx-claude', c);
    expect(r.ok).toBe(true);
    const settings = JSON.parse(readFileSync(editorSettingsPath('cursor', c), 'utf8'));
    expect(settings[WRAPPER_KEY]).toBe('/bin/ccx-claude');
  });

  it('merges into existing valid JSON, preserving other keys', () => {
    const c = ctxWithHome();
    const file = editorSettingsPath('cursor', c);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ 'editor.fontSize': 15 }), 'utf8');
    installEditorWrapper('cursor', '/bin/ccx-claude', c);
    const settings = JSON.parse(readFileSync(file, 'utf8'));
    expect(settings['editor.fontSize']).toBe(15);
    expect(settings[WRAPPER_KEY]).toBe('/bin/ccx-claude');
  });

  it('REFUSES to write when the file has comments (never clobbers)', () => {
    const c = ctxWithHome();
    const file = editorSettingsPath('cursor', c);
    mkdirSync(path.dirname(file), { recursive: true });
    const original = '{\n  // my settings\n  "editor.fontSize": 15\n}';
    writeFileSync(file, original, 'utf8');
    const r = installEditorWrapper('cursor', '/bin/ccx-claude', c);
    expect(r.ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(original); // untouched
  });

  it('removes the wrapper on uninstall', () => {
    const c = ctxWithHome();
    installEditorWrapper('cursor', '/bin/ccx-claude', c);
    const r = uninstallEditorWrapper('cursor', c);
    expect(r.ok).toBe(true);
    const settings = JSON.parse(readFileSync(editorSettingsPath('cursor', c), 'utf8'));
    expect(settings[WRAPPER_KEY]).toBeUndefined();
    expect(existsSync(`${editorSettingsPath('cursor', c)}.cas-backup`)).toBe(true);
  });
});
