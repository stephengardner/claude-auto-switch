import { existsSync, readFileSync, copyFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  editorSettingsPath,
  setWrapperSetting,
  clearWrapperSetting,
  setEnvVar,
  clearEnvVar,
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

/**
 * Safely transform an editor's settings.json: parse (refusing on JSONC it can't
 * parse), transform, back up, and write. Never clobbers on a parse failure.
 */
function updateSettings(
  editor: Editor,
  c: PathCtx,
  hint: string,
  transform: (s: Record<string, unknown>) => Record<string, unknown>,
): InstallOutcome {
  const file = editorSettingsPath(editor, c);
  const settings = parseSettings(file);
  if (settings === null) {
    return { ok: false, path: file, reason: `could not safely parse ${file} (comments?); ${hint}` };
  }
  writeSettings(file, transform(settings));
  return { ok: true, path: file, action: 'installed' };
}

/** Inject an environment variable into the editor's Claude (the safe path). */
export function installEditorEnvVar(
  editor: Editor,
  name: string,
  value: string,
  c: PathCtx = {},
): InstallOutcome {
  return updateSettings(editor, c, `set "${name}": "${value}" under claudeCode.environmentVariables yourself`, (s) =>
    setEnvVar(s, name, value),
  );
}

/** Remove an injected environment variable. */
export function uninstallEditorEnvVar(editor: Editor, name: string, c: PathCtx = {}): InstallOutcome {
  const file = editorSettingsPath(editor, c);
  if (!existsSync(file)) return { ok: true, path: file, action: 'noop' };
  return updateSettings(editor, c, `remove ${name} yourself`, (s) => clearEnvVar(s, name));
}

/** Point the editor's Claude launcher at ccx-claude (the wrapper path; macOS/Linux). */
export function installEditorWrapper(
  editor: Editor,
  wrapperPath: string,
  c: PathCtx = {},
): InstallOutcome {
  return updateSettings(editor, c, `add "claudeCode.claudeProcessWrapper": "${wrapperPath}" yourself`, (s) =>
    setWrapperSetting(s, wrapperPath),
  );
}

/** Remove the editor's Claude launcher override. */
export function uninstallEditorWrapper(editor: Editor, c: PathCtx = {}): InstallOutcome {
  const file = editorSettingsPath(editor, c);
  if (!existsSync(file)) return { ok: true, path: file, action: 'noop' };
  return updateSettings(editor, c, 'remove the setting yourself', (s) => clearWrapperSetting(s));
}
