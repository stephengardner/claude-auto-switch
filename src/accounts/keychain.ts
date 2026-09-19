import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';

export interface KeychainOptions {
  platform?: NodeJS.Platform;
  username?: string;
  exec?: typeof execFileSync;
}

/** Claude namespaces an explicit CLAUDE_CONFIG_DIR by its NFC-normalized path. */
export function keychainService(dir: string): string {
  const hash = createHash('sha256').update(dir.normalize('NFC')).digest('hex');
  return `Claude Code-credentials-${hash.slice(0, 8)}`;
}

function username(options: KeychainOptions): string {
  const name = options.username ?? (process.env.USER || userInfo().username);
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : 'claude-code-user';
}

function missing(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 44;
}

/** No global/default Keychain fallback: it could belong to a different account. */
export function readKeychainCredential(dir: string, options: KeychainOptions = {}): string | null {
  if ((options.platform ?? process.platform) !== 'darwin') return null;
  try {
    return (
      (options.exec ?? execFileSync)(
        '/usr/bin/security',
        ['find-generic-password', '-a', username(options), '-w', '-s', keychainService(dir)],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 2000 },
      )
        .toString()
        .trim() || null
    );
  } catch (error) {
    if (missing(error)) return null;
    // Child-process errors include stdout/stderr, which can contain credentials.
    throw new Error('Could not read the profile login from macOS Keychain');
  }
}

/** Feed the secret over stdin, never in argv or a shell command. */
export function writeKeychainCredential(
  dir: string,
  text: string,
  options: KeychainOptions = {},
): void {
  if ((options.platform ?? process.platform) !== 'darwin') {
    throw new Error('macOS Keychain is unavailable on this platform');
  }
  try {
    const command = `add-generic-password -U -a "${username(options)}" -s "${keychainService(dir)}" -X "${Buffer.from(text).toString('hex')}"\n`;
    (options.exec ?? execFileSync)('/usr/bin/security', ['-i'], {
      input: command,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 2000,
    });
    // Interactive security can exit successfully even when a command failed.
    if (readKeychainCredential(dir, options) !== text.trim()) throw new Error('write failed');
  } catch {
    throw new Error('Could not save the profile login in macOS Keychain');
  }
}

export function deleteKeychainCredential(dir: string, options: KeychainOptions = {}): void {
  if ((options.platform ?? process.platform) !== 'darwin') return;
  try {
    (options.exec ?? execFileSync)(
      '/usr/bin/security',
      ['delete-generic-password', '-a', username(options), '-s', keychainService(dir)],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 2000 },
    );
  } catch (error) {
    if (!missing(error)) throw new Error('Could not remove the profile login from macOS Keychain');
  }
}
