import { existsSync, readFileSync, copyFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  parse as parseJsonc,
  modify,
  applyEdits,
  type ParseError,
  type FormattingOptions,
} from 'jsonc-parser';
import {
  editorSettingsPath,
  setWrapperSetting,
  clearWrapperSetting,
  setEnvVar,
  clearEnvVar,
  ENV_KEY,
  WRAPPER_KEY,
  type Editor,
} from './settings.js';
import type { PathCtx } from '../config/paths.js';

export type InstallOutcome =
  | { ok: true; path: string; action: 'installed' | 'removed' | 'noop' }
  | { ok: false; path: string; reason: string };

/**
 * Parse a settings.json tolerantly. Editor settings are JSONC (comments and
 * trailing commas are valid), so we use a JSONC parser rather than JSON.parse.
 * Returns null ONLY when the file is genuinely malformed (real syntax errors),
 * in which case the caller refuses to write rather than risk clobbering it.
 */
function parseSettings(text: string): Record<string, unknown> | null {
  if (text.trim().length === 0) return {};
  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0) return null;
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

/** Guess the file's indent unit (from its first indented line) so edits match it. */
function detectFormatting(text: string): FormattingOptions {
  const indent = /\n([ \t]+)\S/.exec(text)?.[1];
  if (!indent) return { tabSize: 2, insertSpaces: true };
  if (indent.startsWith('\t')) return { tabSize: 2, insertSpaces: false };
  return { tabSize: indent.length || 2, insertSpaces: true };
}

/**
 * Set (or, with `undefined`, remove) ONE top-level key in an editor's
 * settings.json, preserving every other key, every comment, and the file's
 * formatting (via minimal JSONC edits). Backs the file up first, and refuses to
 * write if the file is genuinely malformed.
 */
function editSettingKey(
  editor: Editor,
  c: PathCtx,
  hint: string,
  key: string,
  compute: (current: Record<string, unknown>) => unknown,
): InstallOutcome {
  const file = editorSettingsPath(editor, c);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const current = parseSettings(text);
  if (current === null) {
    return { ok: false, path: file, reason: `could not safely parse ${file}; ${hint}` };
  }
  const value = compute(current);
  const base = text.trim().length > 0 ? text : '{}';
  const edits = modify(base, [key], value, { formattingOptions: detectFormatting(base) });
  const next = applyEdits(base, edits);
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, `${file}.cas-backup`);
  writeFileSync(file, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
  return { ok: true, path: file, action: value === undefined ? 'removed' : 'installed' };
}

/** Inject an environment variable into the editor's Claude (the safe path). */
export function installEditorEnvVar(
  editor: Editor,
  name: string,
  value: string,
  c: PathCtx = {},
): InstallOutcome {
  return editSettingKey(
    editor,
    c,
    `set "${name}" under ${ENV_KEY} yourself`,
    ENV_KEY,
    (cur) => setEnvVar(cur, name, value)[ENV_KEY],
  );
}

/** Remove an injected environment variable (dropping the key if it becomes empty). */
export function uninstallEditorEnvVar(editor: Editor, name: string, c: PathCtx = {}): InstallOutcome {
  const file = editorSettingsPath(editor, c);
  if (!existsSync(file)) return { ok: true, path: file, action: 'noop' };
  return editSettingKey(editor, c, `remove ${name} yourself`, ENV_KEY, (cur) => {
    const rest = clearEnvVar(cur, name)[ENV_KEY];
    return Array.isArray(rest) && rest.length > 0 ? rest : undefined;
  });
}

/** Read the current value of an injected environment variable, or null. */
export function readEditorEnvVar(editor: Editor, name: string, c: PathCtx = {}): string | null {
  const file = editorSettingsPath(editor, c);
  if (!existsSync(file)) return null;
  const settings = parseSettings(readFileSync(file, 'utf8'));
  if (!settings) return null;
  const raw = settings[ENV_KEY];
  if (!Array.isArray(raw)) return null;
  const entry = raw.find(
    (e): e is { name: string; value: string } =>
      !!e && (e as { name?: string }).name === name && typeof (e as { value?: string }).value === 'string',
  );
  return entry ? entry.value : null;
}

/** Point the editor's Claude launcher at ccx-claude (the wrapper path; macOS/Linux). */
export function installEditorWrapper(
  editor: Editor,
  wrapperPath: string,
  c: PathCtx = {},
): InstallOutcome {
  return editSettingKey(
    editor,
    c,
    `add "${WRAPPER_KEY}": "${wrapperPath}" yourself`,
    WRAPPER_KEY,
    (cur) => setWrapperSetting(cur, wrapperPath)[WRAPPER_KEY],
  );
}

/** Remove the editor's Claude launcher override. */
export function uninstallEditorWrapper(editor: Editor, c: PathCtx = {}): InstallOutcome {
  const file = editorSettingsPath(editor, c);
  if (!existsSync(file)) return { ok: true, path: file, action: 'noop' };
  return editSettingKey(editor, c, 'remove the setting yourself', WRAPPER_KEY, (cur) => clearWrapperSetting(cur)[WRAPPER_KEY]);
}
