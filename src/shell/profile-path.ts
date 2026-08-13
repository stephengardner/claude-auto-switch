import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { homeDir, type PathCtx } from '../config/paths.js';

/** Ask PowerShell for its real `$PROFILE` (handles OneDrive redirection, PS7 vs 5.1). */
function queryRealPowerShellProfile(): string | null {
  for (const exe of ['pwsh', 'powershell']) {
    try {
      const out = execFileSync(exe, ['-NoProfile', '-NoLogo', '-Command', '$PROFILE'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 8000,
      }).trim();
      if (out.toLowerCase().endsWith('.ps1')) return out;
    } catch {
      // try the next executable
    }
  }
  return null;
}

/**
 * Default PowerShell profile path. On a real Windows machine we ask PowerShell
 * for its actual `$PROFILE`, because OneDrive commonly redirects the Documents
 * folder (so the profile lives under `%OneDrive%\Documents`, not
 * `%USERPROFILE%\Documents`) and the two must not be confused. Falls back to an
 * OneDrive-aware computed path. Users can always override with `--profile`.
 */
export interface ProfileDeps {
  /** The machine really being run on. Injected so the Windows path is testable anywhere. */
  hostPlatform?: NodeJS.Platform;
  /** The `$PROFILE` lookup itself, so a test can prove when it is not used. */
  queryProfile?: () => string | null;
}

/**
 * Should we ask the real PowerShell where its profile is?
 *
 * Only when nothing has been injected. Asking PowerShell means asking the real
 * machine, which cannot know about a context the caller made up: a run pointed
 * at a temporary home would be handed the developer's own profile and then
 * edit it. Injecting a platform OR an environment means "this is the machine",
 * so we stay inside what we were given.
 *
 * Exported as its own predicate so this rule is tested on every host, not only
 * on Windows.
 */
export function shouldAskPowerShell(c: PathCtx, host: NodeJS.Platform): boolean {
  return host === 'win32' && c.platform === undefined && c.env === undefined;
}

export function defaultPowerShellProfile(c: PathCtx = {}, deps: ProfileDeps = {}): string {
  const host = deps.hostPlatform ?? process.platform;
  const platform = c.platform ?? host;
  const env = c.env ?? process.env;
  const p = platform === 'win32' ? path.win32 : path.posix;

  if (shouldAskPowerShell(c, host)) {
    const real = (deps.queryProfile ?? queryRealPowerShellProfile)();
    if (real) return real;
  }

  // Fallback: prefer the OneDrive-redirected Documents folder when present.
  const root = platform === 'win32' && env.OneDrive ? env.OneDrive : homeDir(c);
  return p.join(root, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
}

/** Default POSIX shell rc file: `.zshrc` when the shell is zsh, else `.bashrc`. */
export function defaultPosixProfile(c: PathCtx = {}): string {
  const env = c.env ?? process.env;
  const file = (env.SHELL ?? '').includes('zsh') ? '.zshrc' : '.bashrc';
  return path.posix.join(homeDir(c), file);
}
