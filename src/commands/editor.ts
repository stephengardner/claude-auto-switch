import { installEditorEnvVar, readEditorEnvVar, uninstallEditorEnvVar } from '../editor/install.js';
import { editorFolderPath, editorsOnFolder, folderSpellings, namesEditorFolder } from '../editor/folder-login.js';
import { retireEditor, setUpEditor } from '../editor/folder.js';
import { getAccount } from '../accounts/registry.js';
import { getActive } from '../state/active.js';
import type { Editor } from '../editor/settings.js';
import type { CliContext } from '../context.js';

const CONFIG_DIR_VAR = 'CLAUDE_CONFIG_DIR';

function resolveEditor(explicit?: string): Editor {
  return explicit === 'vscode' ? 'vscode' : 'cursor';
}

export interface EditorResult {
  ok: boolean;
  message: string;
}

/**
 * Point one editor at ccx's folder for it, on the active account (reused by
 * `ccx on` and `ccx editor on`). A setting that already names the folder,
 * however it is spelled, is left as it is: on macOS the editor's Claude keeps
 * its login in a Keychain item named after that text.
 */
export function enableEditor(context: CliContext, editor: Editor): EditorResult {
  const active = getActive(context.ctx);
  if (!active || !getAccount(active, context.ctx)) {
    return { ok: false, message: 'no active account yet; run `ccx add <name>` first' };
  }
  const now = readEditorEnvVar(editor, CONFIG_DIR_VAR, context.ctx);
  if (now === null || !namesEditorFolder(now, context.ctx)) {
    const r = installEditorEnvVar(editor, CONFIG_DIR_VAR, editorFolderPath(context.ctx), context.ctx);
    if (!r.ok) return { ok: false, message: r.reason };
  }
  void setUpEditor(context);
  return { ok: true, message: `${editor}: will use your active ccx account (restart ${editor})` };
}

/**
 * Remove ccx from one editor: its setting goes, and the editor's folder is
 * retired once no editor is set to it, with its login and settings handed back.
 */
export function disableEditor(context: CliContext, editor: Editor): EditorResult {
  // Read before the setting goes: its text names the Keychain item the editor's Claude may have saved a login in.
  const spellings = folderSpellings(editorFolderPath(context.ctx), context.ctx);
  const r = uninstallEditorEnvVar(editor, CONFIG_DIR_VAR, context.ctx);
  if (!r.ok) return { ok: false, message: r.reason };
  if (editorsOnFolder(context.ctx).length === 0 && !retireEditor(context, spellings)) {
    return {
      ok: false,
      message: `${editor}: removed ccx, but its folder (${editorFolderPath(context.ctx)}) is kept: what it holds could not all be handed back yet; run \`ccx editor off\` again`,
    };
  }
  return { ok: true, message: `${editor}: removed ccx (restart ${editor})` };
}

/**
 * `ccx editor on|off`: make Cursor / VS Code use your active ccx account.
 *
 * It points the editor's CLAUDE_CONFIG_DIR at a folder ccx keeps for it, the
 * user's own Claude but for the login, which ccx moves to the active account in
 * place. This is safe on every OS: it never changes how the editor launches
 * Claude, only the folder it runs in.
 */
export function editorCommand(
  context: CliContext,
  action: string | undefined,
  opts: { editor?: string } = {},
): number {
  const editor = resolveEditor(opts.editor);
  const r = action === 'off' ? disableEditor(context, editor) : enableEditor(context, editor);
  context.out(r.message);
  return r.ok ? 0 : 1;
}
