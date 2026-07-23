import { installEditorEnvVar, uninstallEditorEnvVar } from '../editor/install.js';
import { syncEditorJunctionToActive, removeEditorJunction, editorJunctionPath } from '../editor/junction.js';
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

/** Point one editor at the active ccx account (reused by `ccx on` and `ccx editor on`). */
export function enableEditor(context: CliContext, editor: Editor): EditorResult {
  if (!syncEditorJunctionToActive(context)) {
    return { ok: false, message: 'no active account yet; run `ccx add <name>` first' };
  }
  const r = installEditorEnvVar(editor, CONFIG_DIR_VAR, editorJunctionPath(context), context.ctx);
  return r.ok
    ? { ok: true, message: `${editor}: will use your active ccx account (restart ${editor})` }
    : { ok: false, message: r.reason };
}

/** Remove ccx from one editor. */
export function disableEditor(context: CliContext, editor: Editor): EditorResult {
  const r = uninstallEditorEnvVar(editor, CONFIG_DIR_VAR, context.ctx);
  removeEditorJunction(context);
  return { ok: r.ok, message: r.ok ? `${editor}: removed ccx (restart ${editor})` : r.reason };
}

/**
 * `ccx editor on|off`: make Cursor / VS Code use your active ccx account.
 *
 * It points the editor's CLAUDE_CONFIG_DIR at a pointer ccx controls (the active
 * account). This is safe on every OS: it never changes how the editor launches
 * Claude, only which account it uses. When your active account changes, the
 * editor's next chat follows.
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
