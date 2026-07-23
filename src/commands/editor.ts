import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installEditorWrapper, uninstallEditorWrapper } from '../editor/install.js';
import type { Editor } from '../editor/settings.js';
import type { CliContext } from '../context.js';

/** Find the ccx-claude launcher on PATH; fall back to this build's editor-cli.js. */
export function resolveWrapperPath(): string {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(cmd, ['ccx-claude'], { encoding: 'utf8' });
    const first = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 0 && existsSync(s));
    if (first) return first;
  } catch {
    /* not on PATH (dev / not linked) */
  }
  return fileURLToPath(new URL('../editor-cli.js', import.meta.url));
}

function resolveEditor(explicit?: string): Editor {
  return explicit === 'vscode' ? 'vscode' : 'cursor';
}

/** `ccx editor on|off [--editor cursor|vscode]`: point the editor at ccx. */
export function editorCommand(
  context: CliContext,
  action: string | undefined,
  opts: { editor?: string } = {},
): number {
  const editor = resolveEditor(opts.editor);

  if (action === 'off') {
    const r = uninstallEditorWrapper(editor, context.ctx);
    context.out(r.ok ? `removed the ccx launcher from ${editor} (${r.path})` : r.reason);
    if (r.ok) context.out(`restart ${editor} to apply.`);
    return r.ok ? 0 : 1;
  }

  const wrapper = resolveWrapperPath();
  const r = installEditorWrapper(editor, wrapper, context.ctx);
  if (!r.ok) {
    context.out(r.reason);
    return 1;
  }
  context.out(`${editor} will now launch Claude through ccx (auto-switches accounts).`);
  context.out(`set in ${r.path}. Restart ${editor} to apply.`);
  return 0;
}
