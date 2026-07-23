import { existsSync, readFileSync, copyFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  editorSettingsPath,
  setWrapperSetting,
  clearWrapperSetting,
  type Editor,
} from './settings.js';
import type { PathCtx } from '../config/paths.js';

export type InstallOutcome =
  | { ok: true; path: string; action: 'installed' | 'removed' | 'noop' }
  | { ok: false; path: string; reason: string };

/**
 * Parse settings.json SAFELY. Editor settings files may contain comments
 * (JSONC), which plain JSON.parse rejects. If a non-empty file will not parse,
 * we return null and the caller REFUSES to write, rather than clobbering the
 * user's settings.
 */
function parseSettings(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8').trim();
  if (text.length === 0) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

function writeSettings(file: string, data: Record<string, unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, `${file}.cas-backup`);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/** Point the editor's Claude launcher at ccx-claude. */
export function installEditorWrapper(
  editor: Editor,
  wrapperPath: string,
  c: PathCtx = {},
): InstallOutcome {
  const file = editorSettingsPath(editor, c);
  const settings = parseSettings(file);
  if (settings === null) {
    return {
      ok: false,
      path: file,
      reason: `could not safely parse ${file} (it may contain comments); add "claudeCode.claudeProcessWrapper": "${wrapperPath}" yourself`,
    };
  }
  writeSettings(file, setWrapperSetting(settings, wrapperPath));
  return { ok: true, path: file, action: 'installed' };
}

/** Remove the editor's Claude launcher override. */
export function uninstallEditorWrapper(editor: Editor, c: PathCtx = {}): InstallOutcome {
  const file = editorSettingsPath(editor, c);
  const settings = parseSettings(file);
  if (settings === null) {
    return { ok: false, path: file, reason: `could not safely parse ${file}; remove the setting yourself` };
  }
  if (!existsSync(file)) return { ok: true, path: file, action: 'noop' };
  writeSettings(file, clearWrapperSetting(settings));
  return { ok: true, path: file, action: 'removed' };
}
