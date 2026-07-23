import path from 'node:path';
import { homeDir, type PathCtx } from '../config/paths.js';

/**
 * Best-effort default PowerShell 7+ profile path. Users on a redirected
 * Documents folder or Windows PowerShell 5 can override with `--profile`.
 */
export function defaultPowerShellProfile(c: PathCtx = {}): string {
  const platform = c.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.join(homeDir(c), 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
}

/** Default POSIX shell rc file: `.zshrc` when the shell is zsh, else `.bashrc`. */
export function defaultPosixProfile(c: PathCtx = {}): string {
  const env = c.env ?? process.env;
  const file = (env.SHELL ?? '').includes('zsh') ? '.zshrc' : '.bashrc';
  return path.posix.join(homeDir(c), file);
}
