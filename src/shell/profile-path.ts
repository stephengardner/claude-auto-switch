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
export function defaultPowerShellProfile(c: PathCtx = {}): string {
  const platform = c.platform ?? process.platform;
  const env = c.env ?? process.env;
  const p = platform === 'win32' ? path.win32 : path.posix;

  // Ground truth, only for real CLI use on Windows (tests inject c.platform).
  if (platform === 'win32' && c.platform === undefined && process.platform === 'win32') {
    const real = queryRealPowerShellProfile();
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
