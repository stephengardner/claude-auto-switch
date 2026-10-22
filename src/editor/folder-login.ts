import { lstatSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  deleteKeychainCredential,
  readKeychainCredential,
  writeKeychainCredential,
} from '../accounts/keychain.js';
import { CREDENTIALS_FILE, readCredential } from '../accounts/credential-storage.js';
import {
  credentialPath,
  loginTextFingerprint,
  nudgeLoginReread,
  usableLoginText,
} from '../accounts/credential-vault.js';
import { CREDENTIALS_LOCK_DIR, withLockDirAsync } from '../claude/locks.js';
import { writeFileAtomic } from '../util/atomic-write.js';
import { writeSecretFile } from '../util/secret-file.js';
import { configHome, type PathCtx } from '../config/paths.js';
import { readEditorEnvVar } from './install.js';
import type { Editor } from './settings.js';

/**
 * The editor's own Claude folder, and the login in it.
 *
 * The editor's Claude runs with CLAUDE_CONFIG_DIR set to this folder by the
 * extension's `claudeCode.environmentVariables` setting, which `ccx editor on`
 * writes. It is built like a terminal session's folder (session/claude-folder),
 * so everything in it but the login is the user's own; only the login, and
 * which account it is, are the editor's.
 *
 * On macOS Claude keeps a login in a Keychain item named after the config folder
 * exactly as it was given it (`keychainService`), then in the folder's file. The
 * name comes from the text in the editor's setting, which can spell the folder
 * differently from ccx (a trailing separator, another case on macOS), so every
 * read and write here goes through the spellings the editors pass.
 */

/** Where the editor's folder is: the path `ccx editor on` puts in the editor's setting. */
export function editorFolderPath(c: PathCtx = {}): string {
  return path.join(configHome(c), 'editor-active');
}

/** ccx's record in the folder of which account its login is, and since when. */
export const EDITOR_RECORD = '.ccx-editor.json';

export interface EditorRecord {
  /** The account whose login ccx last put in the folder, or null when it put none. */
  account: string | null;
  /** When ccx last replaced the login under the editor's Claude, epoch ms. */
  loginChangedAt: number;
  /** How editor settings spelled the folder when ccx tried to retire it, each naming a Keychain item. */
  spellings?: string[];
}

export function readEditorRecord(dir: string): EditorRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, EDITOR_RECORD), 'utf8')) as Partial<EditorRecord>;
    const spellings = Array.isArray(parsed.spellings)
      ? parsed.spellings.filter((s): s is string => typeof s === 'string')
      : [];
    return {
      account: typeof parsed.account === 'string' ? parsed.account : null,
      loginChangedAt: typeof parsed.loginChangedAt === 'number' ? parsed.loginChangedAt : 0,
      ...(spellings.length > 0 ? { spellings } : {}),
    };
  } catch {
    return null;
  }
}

/** Write the folder's record; one without spellings keeps those the record already holds. */
export function writeEditorRecord(dir: string, record: EditorRecord): void {
  const spellings = record.spellings ?? readEditorRecord(dir)?.spellings;
  writeFileAtomic(path.join(dir, EDITOR_RECORD), `${JSON.stringify(spellings ? { ...record, spellings } : record)}\n`);
}

/** Whether the editor's folder is one ccx made: a real folder with its record, not the old link. */
export function isEditorFolder(c: PathCtx = {}): boolean {
  const dir = editorFolderPath(c);
  try {
    if (!lstatSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return readEditorRecord(dir) !== null;
}

const EDITORS: readonly Editor[] = ['cursor', 'vscode'];

/**
 * The CLAUDE_CONFIG_DIR texts the editors are set to that land on `folder`,
 * or ccx's own path when none does (an editor set up by hand, or none yet).
 */
export function folderSpellings(folder: string, c: PathCtx = {}): string[] {
  const found = new Set<string>();
  for (const editor of EDITORS) {
    let value: string | null = null;
    try {
      value = readEditorEnvVar(editor, 'CLAUDE_CONFIG_DIR', c);
    } catch {
      value = null;
    }
    if (value !== null && landsOn(value, folder, c)) found.add(value);
  }
  return found.size > 0 ? [...found] : [folder];
}

/** The editors whose CLAUDE_CONFIG_DIR names the editor's folder. */
export function editorsOnFolder(c: PathCtx = {}): Editor[] {
  const folder = editorFolderPath(c);
  return EDITORS.filter((editor) => {
    try {
      const value = readEditorEnvVar(editor, 'CLAUDE_CONFIG_DIR', c);
      return value !== null && landsOn(value, folder, c);
    } catch {
      return false;
    }
  });
}

/** Whether a CLAUDE_CONFIG_DIR text names the editor's folder, however it is spelled. */
export function namesEditorFolder(value: string, c: PathCtx = {}): boolean {
  return landsOn(value, editorFolderPath(c), c);
}

/** Whether `value` names `folder`: the same path once resolved, by the platform's case rule, or the same folder on disk. */
function landsOn(value: string, folder: string, c: PathCtx): boolean {
  const platform = c.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const plain = (text: string): string => {
    const resolved = p.resolve(text);
    return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
  };
  if (plain(value) === plain(folder)) return true;
  try {
    const a = statSync(value, { bigint: true });
    const b = statSync(folder, { bigint: true });
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

/** A Claude folder and every spelling of it a Claude may have been given. */
export interface FolderLogin {
  dir: string;
  spellings: string[];
}

/**
 * The editor folder's login, as the editors' Claudes are pointed at it, and as
 * they were when a setting was taken away: a Claude started before then still
 * reads the item named after it.
 */
export function editorFolderLogin(c: PathCtx = {}): FolderLogin {
  const dir = editorFolderPath(c);
  return { dir, spellings: [...new Set([...folderSpellings(dir, c), ...(readEditorRecord(dir)?.spellings ?? [])])] };
}

const fileOf = (login: FolderLogin): string => path.join(login.dir, CREDENTIALS_FILE);

/** The login as Claude reads it: a Keychain item named after a spelling, else the file. Null when there is none. */
export function readFolderLogin(login: FolderLogin): string | null {
  for (const spelling of login.spellings) {
    const item = readKeychainCredential(spelling);
    if (item !== null) return item;
  }
  try {
    return readFileSync(fileOf(login), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw error;
  }
}

/** Whether a Keychain item holds the folder's login for any spelling. */
export function folderKeychainHolds(login: FolderLogin): boolean {
  return login.spellings.some((spelling) => readKeychainCredential(spelling) !== null);
}

/**
 * Write `text` where each Claude on the folder reads it: into the Keychain item
 * of every spelling that has one, and into the file whenever a spelling has
 * none, since a Claude given that spelling reads the file.
 */
export function writeFolderLogin(login: FolderLogin, text: string): void {
  let everyOneHasAnItem = login.spellings.length > 0;
  for (const spelling of login.spellings) {
    if (readKeychainCredential(spelling) !== null) writeKeychainCredential(spelling, text);
    else everyOneHasAnItem = false;
  }
  if (!everyOneHasAnItem) writeSecretFile(fileOf(login), text);
}

/** Remove the login from every place a Claude on the folder could read it. */
export function removeFolderLogin(login: FolderLogin): void {
  const errors: unknown[] = [];
  for (const spelling of login.spellings) {
    try {
      deleteKeychainCredential(spelling);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    rmSync(fileOf(login), { force: true });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw errors[0];
}

/** The fingerprint of the folder's login (credentialFingerprint's), or null. */
export function folderLoginFingerprint(login: FolderLogin): string | null {
  try {
    const text = readFolderLogin(login);
    return text === null ? null : loginTextFingerprint(text);
  } catch {
    return null;
  }
}

/** Make a Claude running on the folder read its login again at its next request (nudgeLoginReread). */
export function nudgeFolderLogin(login: FolderLogin, now: Date = new Date()): boolean {
  return nudgeLoginReread(login.dir, now, { keychainHolds: () => folderKeychainHolds(login) });
}

/**
 * The editor folder's login when it holds exactly the login `fingerprint`
 * names, null when it does not, and 'unreadable' when that cannot be told: a
 * Keychain read that failed is not a Keychain with nothing in it.
 */
export function editorHolding(fingerprint: string | null, c: PathCtx = {}): FolderLogin | 'unreadable' | null {
  if (fingerprint === null || !isEditorFolder(c)) return null;
  const login = editorFolderLogin(c);
  let text: string | null;
  try {
    text = readFolderLogin(login);
  } catch {
    return 'unreadable';
  }
  return text !== null && loginTextFingerprint(text) === fingerprint ? login : null;
}

/**
 * Put `text`, a renewal of the login `retired` names, in the folder, but only
 * while the folder still holds that one: a sign-in there meanwhile is never
 * replaced by an older login. The caller holds the folder's login lock.
 */
export function replaceFolderLogin(login: FolderLogin, retired: string, text: string): boolean {
  if (!usableLoginText(text) || folderLoginFingerprint(login) !== retired) return false;
  writeFolderLogin(login, text);
  nudgeFolderLogin(login);
  return true;
}

/**
 * For propagateRenewal: carry a renewal into the editor's folder when it holds
 * the login that renewal retired, under the lock its Claude takes, as a profile
 * sharing that login is carried into. Without it, a terminal session that renews
 * a login the editor holds too leaves the editor on a token the server has
 * retired. It runs on the thread that relays a terminal, so it waits for the
 * lock on timers, never blocking that thread; one not made then waits in the
 * carry queue (queueEditorCarry). `accountDir` is the profile the renewal was
 * saved to, before this is called.
 */
export function carryIntoEditor(c: PathCtx, accountDir: string): (retired: string, snapshotFile: string) => void {
  return (retired) => {
    if (editorHolding(retired, c) === null) return;
    queueEditorCarry(c, retired, accountDir);
    void retryEditorCarries(c);
  };
}

/**
 * Carries into the editor's folder not made yet, one file per login each
 * would replace, naming the profile that holds its renewal: each stays until it
 * is made or the folder no longer holds that login, whatever ccx process wrote
 * it and whichever looks next. No login is written here, only where to read one.
 */
const carriesDir = (c: PathCtx): string => path.join(configHome(c), 'editor-carries');

/**
 * Note that the editor's folder holds `retired`, a login whose renewal is now
 * in the profile at `accountDir`, and is to have that renewal put in its place.
 */
export function queueEditorCarry(c: PathCtx, retired: string, accountDir: string): void {
  try {
    writeFileAtomic(path.join(carriesDir(c), `${retired}.json`), `${JSON.stringify({ accountDir })}\n`);
  } catch {
    /* the editor's next event still pulls the profile's newer login in (pullProfileIntoEditor) */
  }
}

/** The ccx homes whose queue a look is going through now, so a second look does not start beside it. */
const carrying = new Set<string>();

/**
 * Make each carry in the queue, under the lock the editor's Claude takes,
 * waiting for it on timers. True when none is left.
 */
export async function retryEditorCarries(c: PathCtx): Promise<boolean> {
  let key: string;
  let names: string[];
  try {
    key = configHome(c);
    names = readdirSync(carriesDir(c)).filter((name) => name.endsWith('.json'));
  } catch {
    return true;
  }
  if (names.length === 0) return true;
  if (carrying.has(key)) return false;
  carrying.add(key);
  try {
    let left = 0;
    for (const name of names) {
      if (!(await makeCarry(c, name.slice(0, -'.json'.length), path.join(carriesDir(c), name)))) left++;
    }
    return left === 0;
  } finally {
    carrying.delete(key);
  }
}

/** One carry from the queue: true once it is made, or not needed any more. */
async function makeCarry(c: PathCtx, retired: string, file: string): Promise<boolean> {
  try {
    const holding = editorHolding(retired, c);
    if (holding === 'unreadable') return false;
    if (holding !== null) {
      const { accountDir } = JSON.parse(readFileSync(file, 'utf8')) as { accountDir?: unknown };
      const text = typeof accountDir === 'string' ? readCredential(credentialPath(accountDir)) : null;
      if (text !== null && usableLoginText(text) && loginTextFingerprint(text) !== retired) {
        const login: FolderLogin = holding;
        const made = await withLockDirAsync(path.join(login.dir, CREDENTIALS_LOCK_DIR), {}, (lock) => {
          if (!lock.held) return false;
          replaceFolderLogin(login, retired, text);
          return true;
        });
        if (!made) return false;
      }
    }
    rmSync(file, { force: true });
    return true;
  } catch {
    return false; // tried again at the next look
  }
}

/** How long the process whose write into the editor's folder failed keeps trying it, once a second, before it may end. */
export const EDITOR_CARRY_SOON_MS = 10_000;

/** Try the queue again once a second for `forMs`, until it is empty. */
export async function retryEditorCarriesSoon(c: PathCtx, forMs: number = EDITOR_CARRY_SOON_MS): Promise<void> {
  const until = Date.now() + forMs;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (await retryEditorCarries(c)) return;
  }
}
