import { installShim, uninstallShim, type ShellKind } from '../shell/install-shim.js';
import { defaultPowerShellProfile, defaultPosixProfile } from '../shell/profile-path.js';
import type { CliContext } from '../context.js';

export interface ShimOptions {
  profile?: string;
  /** 'powershell' or 'posix'; defaults to the platform. */
  shell?: string;
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

/** Install the transparent `claude` shim into the shell profile. */
export function onCommand(context: CliContext, options: ShimOptions = {}): number {
  const { shell, profilePath } = resolveTarget(context, options);
  if (installShim(profilePath, shell) === 'installed') {
    context.out(`transparent claude shim installed in ${profilePath}`);
    context.out(
      shell === 'powershell'
        ? 'reload your shell (or run: . $PROFILE) to activate it'
        : 'reload your shell (or source the profile) to activate it',
    );
  } else {
    context.out(`shim already present in ${profilePath}`);
  }
  return 0;
}

/** Remove the transparent `claude` shim from the shell profile. */
export function offCommand(context: CliContext, options: ShimOptions = {}): number {
  const { profilePath } = resolveTarget(context, options);
  const result = uninstallShim(profilePath);
  context.out(result === 'removed' ? `shim removed from ${profilePath}` : `no shim found in ${profilePath}`);
  return 0;
}
