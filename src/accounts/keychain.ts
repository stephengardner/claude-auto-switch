import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';

/**
 * `security`, the program macOS reaches the Keychain through. Each call has a
 * form that blocks the thread and one that waits off it; a running session
 * reaches them only through keychain-view, which says which to use.
 */

/** How `security` is run off the thread: its standard output, or a failure carrying its exit status as `code`. */
export type ExecAsync = (file: string, args: string[], options: { input?: string; timeout: number }) => Promise<string>;

export interface KeychainOptions {
  platform?: NodeJS.Platform;
  username?: string;
  exec?: typeof execFileSync;
  execAsync?: ExecAsync;
}

const SECURITY = '/usr/bin/security';
/** The longest one `security` call may take. */
const TIMEOUT_MS = 2000;
/** The exit status `security` gives for an item that is not there. */
const NOT_FOUND = 44;

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
  const failed = error as { status?: unknown; code?: unknown } | null;
  return failed?.status === NOT_FOUND || failed?.code === NOT_FOUND;
}

const onMac = (options: KeychainOptions): boolean => (options.platform ?? process.platform) === 'darwin';
const findArgs = (dir: string, options: KeychainOptions): string[] => [
  'find-generic-password',
  '-a',
  username(options),
  '-w',
  '-s',
  keychainService(dir),
];
const addCommand = (dir: string, text: string, options: KeychainOptions): string =>
  `add-generic-password -U -a "${username(options)}" -s "${keychainService(dir)}" -X "${Buffer.from(text).toString('hex')}"\n`;
const deleteArgs = (dir: string, options: KeychainOptions): string[] => [
  'delete-generic-password',
  '-a',
  username(options),
  '-s',
  keychainService(dir),
];

// Child-process errors include stdout/stderr, which can contain credentials.
const readFailed = (): Error => new Error('Could not read the profile login from macOS Keychain');
const writeFailed = (): Error => new Error('Could not save the profile login in macOS Keychain');
const deleteFailed = (): Error => new Error('Could not remove the profile login from macOS Keychain');

/** execFile, its input written to its standard input, and its output whole once it ends. */
export const execFileAsync: ExecAsync = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: 'utf8', timeout: options.timeout }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin?.on('error', () => {
      /* the program ended before reading it; its exit says how it went */
    });
    child.stdin?.end(options.input ?? '');
  });

/** No global/default Keychain fallback: it could belong to a different account. */
export function readKeychainCredential(dir: string, options: KeychainOptions = {}): string | null {
  if (!onMac(options)) return null;
  try {
    return (
      (options.exec ?? execFileSync)(SECURITY, findArgs(dir, options), {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: TIMEOUT_MS,
      })
        .toString()
        .trim() || null
    );
  } catch (error) {
    if (missing(error)) return null;
    throw readFailed();
  }
}

/** readKeychainCredential with the thread free while `security` runs. */
export async function readKeychainCredentialAsync(dir: string, options: KeychainOptions = {}): Promise<string | null> {
  if (!onMac(options)) return null;
  try {
    return (await (options.execAsync ?? execFileAsync)(SECURITY, findArgs(dir, options), { timeout: TIMEOUT_MS })).trim() || null;
  } catch (error) {
    if (missing(error)) return null;
    throw readFailed();
  }
}

/** Feed the secret over stdin, never in argv or a shell command. */
export function writeKeychainCredential(dir: string, text: string, options: KeychainOptions = {}): void {
  if (!onMac(options)) {
    throw new Error('macOS Keychain is unavailable on this platform');
  }
  try {
    (options.exec ?? execFileSync)(SECURITY, ['-i'], {
      input: addCommand(dir, text, options),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
    });
    // Interactive security can exit successfully even when a command failed.
    if (readKeychainCredential(dir, options) !== text.trim()) throw new Error('write failed');
  } catch {
    throw writeFailed();
  }
}

/** writeKeychainCredential with the thread free while `security` runs. */
export async function writeKeychainCredentialAsync(dir: string, text: string, options: KeychainOptions = {}): Promise<void> {
  if (!onMac(options)) {
    throw new Error('macOS Keychain is unavailable on this platform');
  }
  try {
    await (options.execAsync ?? execFileAsync)(SECURITY, ['-i'], { input: addCommand(dir, text, options), timeout: TIMEOUT_MS });
    if ((await readKeychainCredentialAsync(dir, options)) !== text.trim()) throw new Error('write failed');
  } catch {
    throw writeFailed();
  }
}

export function deleteKeychainCredential(dir: string, options: KeychainOptions = {}): void {
  if (!onMac(options)) return;
  try {
    (options.exec ?? execFileSync)(SECURITY, deleteArgs(dir, options), {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
    });
  } catch (error) {
    if (!missing(error)) throw deleteFailed();
  }
}

/** deleteKeychainCredential with the thread free while `security` runs. */
export async function deleteKeychainCredentialAsync(dir: string, options: KeychainOptions = {}): Promise<void> {
  if (!onMac(options)) return;
  try {
    await (options.execAsync ?? execFileAsync)(SECURITY, deleteArgs(dir, options), { timeout: TIMEOUT_MS });
  } catch (error) {
    if (!missing(error)) throw deleteFailed();
  }
}
