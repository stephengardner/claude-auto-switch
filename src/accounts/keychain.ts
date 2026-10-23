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
/**
 * The longest command `security -i` takes whole. It reads a line in 4 KB
 * pieces and runs each, so a longer add stores the login cut short and only
 * then fails (measured: a 4066-byte line intact, a 4160-byte one cut).
 */
const INTERACTIVE_LINE_LIMIT = 4000;

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
/**
 * How to save `text`: as a line on standard input, or, for a login too long
 * for one, in the arguments, as Claude Code saves one. Arguments can be seen
 * by programs running as this user while `security` runs; standard input
 * cannot, so it is used whenever the login fits.
 */
const addCall = (dir: string, text: string, options: KeychainOptions): { args: string[]; input?: string } => {
  const hex = Buffer.from(text).toString('hex');
  const line = `add-generic-password -U -a "${username(options)}" -s "${keychainService(dir)}" -X "${hex}"\n`;
  if (Buffer.byteLength(line) <= INTERACTIVE_LINE_LIMIT) return { args: ['-i'], input: line };
  return { args: ['add-generic-password', '-U', '-a', username(options), '-s', keychainService(dir), '-X', hex] };
};
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

/**
 * Save `text` as the login, never in a shell command. A write the item does
 * not then show puts back what the item held before, so a failed write never
 * leaves a broken login in place of a working one.
 */
export function writeKeychainCredential(dir: string, text: string, options: KeychainOptions = {}): void {
  if (!onMac(options)) {
    throw new Error('macOS Keychain is unavailable on this platform');
  }
  const add = (value: string): void => {
    const call = addCall(dir, value, options);
    (options.exec ?? execFileSync)(SECURITY, call.args, {
      ...(call.input !== undefined ? { input: call.input } : {}),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
    });
  };
  let before: string | null | undefined;
  try {
    before = readKeychainCredential(dir, options);
  } catch {
    before = undefined; // unknown, so nothing is put back
  }
  try {
    add(text);
    // Interactive security can exit successfully even when a command failed.
    if (readKeychainCredential(dir, options) !== text.trim()) throw new Error('write failed');
  } catch {
    try {
      if (typeof before === 'string') add(before);
      else if (before === null) deleteKeychainCredential(dir, options);
    } catch {
      /* the write's own failure is the one to report */
    }
    throw writeFailed();
  }
}

/** writeKeychainCredential with the thread free while `security` runs. */
export async function writeKeychainCredentialAsync(dir: string, text: string, options: KeychainOptions = {}): Promise<void> {
  if (!onMac(options)) {
    throw new Error('macOS Keychain is unavailable on this platform');
  }
  const add = async (value: string): Promise<void> => {
    const call = addCall(dir, value, options);
    await (options.execAsync ?? execFileAsync)(SECURITY, call.args, {
      ...(call.input !== undefined ? { input: call.input } : {}),
      timeout: TIMEOUT_MS,
    });
  };
  let before: string | null | undefined;
  try {
    before = await readKeychainCredentialAsync(dir, options);
  } catch {
    before = undefined;
  }
  try {
    await add(text);
    if ((await readKeychainCredentialAsync(dir, options)) !== text.trim()) throw new Error('write failed');
  } catch {
    try {
      if (typeof before === 'string') await add(before);
      else if (before === null) await deleteKeychainCredentialAsync(dir, options);
    } catch {
      /* the write's own failure is the one to report */
    }
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
