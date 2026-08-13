import { installShim, uninstallShim, type ShellKind } from '../shell/install-shim.js';
import { defaultPowerShellProfile, defaultPosixProfile } from '../shell/profile-path.js';
import { detectEditors } from '../editor/settings.js';
import { enableEditor, disableEditor } from './editor.js';
import { installStatusline, removeStatusline } from '../statusline/settings-install.js';
import type { CliContext } from '../context.js';

export interface ShimOptions {
  profile?: string;
  /** 'powershell' or 'posix'; defaults to the platform. */
  shell?: string;
  /** Set false to skip setting up installed editors (--no-editor). */
  editor?: boolean;
  /** Set false to leave Claude's status line alone (--no-statusline). */
  statusline?: boolean;
}

function resolveTarget(
  context: CliContext,
  options: ShimOptions,
): { shell: ShellKind; profilePath: string } {
  const platform = context.ctx.platform ?? process.platform;
  const shell: ShellKind =
    options.shell === 'powershell' || options.shell === 'posix'
      ? options.shell
      : platform === 'win32'
        ? 'powershell'
        : 'posix';
  const profilePath =
    options.profile ??
    (shell === 'powershell' ? defaultPowerShellProfile(context.ctx) : defaultPosixProfile(context.ctx));
  return { shell, profilePath };
}

/**
 * One-command setup: install the transparent `claude` shim in the shell AND, for
 * any editor you have installed, point it at your active ccx account. Pass
 * `editor: false` (--no-editor) to set up the terminal only.
 */
export function onCommand(context: CliContext, options: ShimOptions = {}): number {
  const { shell, profilePath } = resolveTarget(context, options);
  if (installShim(profilePath, shell) === 'installed') {
    context.out(`terminal: transparent \`claude\` installed in ${profilePath}`);
    context.out(
      shell === 'powershell' ? '  reload your shell (or run: . $PROFILE)' : '  reload your shell',
    );
  } else {
    context.out(`terminal: shim already present in ${profilePath}`);
  }

  if (options.statusline !== false) {
    context.out(statuslineMessage(installStatusline(context.ctx)));
  }

  if (options.editor !== false) {
    for (const editor of detectEditors(context.ctx)) {
      context.out(enableEditor(context, editor).message);
    }
  }
  return 0;
}

/**
 * Say what happened to the status line, including when nothing did. The shim is
 * invisible on purpose, so this line is how someone knows ccx is on at all.
 */
function statuslineMessage(result: ReturnType<typeof installStatusline>): string {
  switch (result.outcome) {
    case 'installed':
      return 'claude: status line shows your account and remaining room (restart claude to see it)';
    case 'wrapped':
      return 'claude: status line added alongside the one you already had (restart claude to see it)';
    case 'already':
      return 'claude: status line already set up';
    case 'unreadable':
      return `claude: left ${result.file} alone, it is not valid JSON. Fix it and run \`ccx on\` again`;
    default:
      return `claude: could not write ${result.file || 'settings.json'}; run \`ccx statusline --install\` for the snippet`;
  }
}

/** Remove the shim from the shell, and ccx from any installed editors. */
export function offCommand(context: CliContext, options: ShimOptions = {}): number {
  const { profilePath } = resolveTarget(context, options);
  const result = uninstallShim(profilePath);
  context.out(result === 'removed' ? `terminal: shim removed from ${profilePath}` : `terminal: no shim found`);

  if (options.statusline !== false) {
    const line = removeStatusline(context.ctx);
    if (line.outcome === 'removed') context.out('claude: status line removed');
    else if (line.outcome === 'restored') context.out('claude: your previous status line is back');
    else if (line.outcome === 'unreadable') context.out(`claude: left ${line.file} alone, it is not valid JSON`);
  }

  if (options.editor !== false) {
    for (const editor of detectEditors(context.ctx)) {
      context.out(disableEditor(context, editor).message);
    }
  }
  return 0;
}
