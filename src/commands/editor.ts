import { installEditorEnvVar, uninstallEditorEnvVar } from '../editor/install.js';
import { syncEditorJunctionToActive, removeEditorJunction, editorJunctionPath } from '../editor/junction.js';
import type { Editor } from '../editor/settings.js';
import type { CliContext } from '../context.js';

const CONFIG_DIR_VAR = 'CLAUDE_CONFIG_DIR';

function resolveEditor(explicit?: string): Editor {
  return explicit === 'vscode' ? 'vscode' : 'cursor';
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

  if (action === 'off') {
    const r = uninstallEditorEnvVar(editor, CONFIG_DIR_VAR, context.ctx);
    removeEditorJunction(context);
    context.out(r.ok ? `removed ccx from ${editor} (${r.path})` : r.reason);
    if (r.ok) context.out(`restart ${editor} to apply.`);
    return r.ok ? 0 : 1;
  }

  if (!syncEditorJunctionToActive(context)) {
    context.out('no active account yet. Run `ccx add <name>` (twice), then `ccx editor on`.');
    return 1;
  }
  const r = installEditorEnvVar(editor, CONFIG_DIR_VAR, editorJunctionPath(context), context.ctx);
  if (!r.ok) {
    context.out(r.reason);
    return 1;
  }
  context.out(`${editor} will now use your active ccx account, and follow switches.`);
  context.out(`set in ${r.path}. Restart ${editor} to apply.`);
  return 0;
}
