import path from 'node:path';
import { homeDir, type PathCtx } from '../config/paths.js';

export type Editor = 'cursor' | 'vscode';

/** Folder name each editor uses under the per-user config location. */
const APP_DIR: Record<Editor, string> = { cursor: 'Cursor', vscode: 'Code' };

/** The extension setting that names the program used to launch Claude. */
export const WRAPPER_KEY = 'claudeCode.claudeProcessWrapper';

/** The user `settings.json` path for an editor, per OS. */
export function editorSettingsPath(editor: Editor, c: PathCtx = {}): string {
  const platform = c.platform ?? process.platform;
  const env = c.env ?? process.env;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const app = APP_DIR[editor];
  if (platform === 'win32') {
    const appdata = env.APPDATA ?? p.join(homeDir(c), 'AppData', 'Roaming');
    return p.join(appdata, app, 'User', 'settings.json');
  }
  if (platform === 'darwin') {
    return p.join(homeDir(c), 'Library', 'Application Support', app, 'User', 'settings.json');
  }
  return p.join(homeDir(c), '.config', app, 'User', 'settings.json');
}

/** Set the wrapper path, preserving every other setting. Pure. */
export function setWrapperSetting(
  settings: Record<string, unknown>,
  wrapperPath: string,
): Record<string, unknown> {
  return { ...settings, [WRAPPER_KEY]: wrapperPath };
}

/** Remove the wrapper setting, preserving every other setting. Pure. */
export function clearWrapperSetting(settings: Record<string, unknown>): Record<string, unknown> {
  const next = { ...settings };
  delete next[WRAPPER_KEY];
  return next;
}
