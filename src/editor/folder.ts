import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, existsSync, type Stats } from 'node:fs';
import path from 'node:path';
import { getAccount, listAccounts } from '../accounts/registry.js';
import type { Account } from '../accounts/registry.schema.js';
import { getActive } from '../state/active.js';
import { configHome, type PathCtx } from '../config/paths.js';
import { readTarget, removeTarget, setTarget } from '../daemon/junction.js';
import { acquireOwnedLock, CREDENTIALS_LOCK_DIR, lockDirHeld, withCredentialLockIfFree } from '../claude/locks.js';
import { CREDENTIALS_FILE, readCredential } from '../accounts/credential-storage.js';
import {
  credentialFingerprint,
  credentialPath,
  hasUsableLogin,
  identityKey,
  installCredential,
  loginTextFingerprint,
  sessionIdentityEmail,
  usableLoginText,
} from '../accounts/credential-vault.js';
import { readKeychainCredential } from '../accounts/keychain.js';
import { loginExpiresAt, readExpiresAt } from '../usage/token-expiry.js';
import { loginIsKnownDead } from '../usage/dead-login-store.js';
import { sha256Fingerprint } from '../util/fingerprint.js';
import { decideSaveBack } from '../accounts/save-back.js';
import { decidePull } from '../accounts/credential-sync.js';
import { writeAndCarry } from '../accounts/shared-login.js';
import { carryTargets } from '../accounts/duplicate-guard.js';
import { fetchTokenOwner } from '../accounts/identity-check.js';
import { logCredentialEvent } from '../accounts/credential-log.js';
import { appendEvent } from '../events/log.js';
import { secureMkdir, writeSecretFile } from '../util/secret-file.js';
import { writeFileAtomic } from '../util/atomic-write.js';
import {
  applyAccountIdentity,
  buildClaudeFolder,
  moveFolderLogin,
  refreshClaudeFolder,
  type FolderLoginStore,
} from '../session/claude-folder.js';
import { handBackOrRescue, rescueStateChoices, snapshotStateBase, writeUserFile } from '../session/write-back.js';
import { adoptFolderHistory, returnSharedUserFiles, type UserFileWriter } from '../session/shared-root.js';
import { removeSessionDir } from '../session/session-dir.js';
import { processIsAlive } from '../session/lease.js';
import { editorPointerAccount, editorTargetAccount, syncEditorPointerIfEnabled } from './junction.js';
import {
  editorFolderLogin,
  editorFolderPath,
  folderLoginFingerprint,
  isEditorFolder,
  nudgeFolderLogin,
  readEditorRecord,
  readFolderLogin,
  removeFolderLogin,
  writeEditorRecord,
  writeFolderLogin,
  type FolderLogin,
} from './folder-login.js';
import type { CliContext } from '../context.js';

/**
 * The editor's Claude folder, kept by ccx.
 *
 * The editor's Claude runs with its CLAUDE_CONFIG_DIR set to a folder built
 * like a terminal session's (session/claude-folder): the user's own projects,
 * settings, memory, skills, agents and commands, and a login of its own. A
 * switch replaces that login in place, as a terminal session's move does, so
 * a chat open in the editor carries on on the next account, and the folder
 * never changes. Unlike a session's it never ends, so ccx brings it into step
 * with the user's ~/.claude at its own events: every switch, `ccx on`,
 * `ccx editor on`, `ccx doctor`, and every terminal session's start.
 *
 * It replaced a link at the same path that ccx pointed at the active account's
 * own folder, which split the editor's history by account and lost the user's
 * setup. The first ccx event after an upgrade moves an install off that link
 * (moveIntoFolder), keeping the path, so the editor's setting stays as it is.
 */

/** Keeps two of ccx's changes to the editor's folder (a refresh, a move, the move off the old link, retiring it) apart. */
function withEditorLock<T>(c: PathCtx, fn: () => T): { ran: true; value: T } | { ran: false } {
  let lock: ReturnType<typeof acquireOwnedLock>;
  try {
    const home = configHome(c);
    mkdirSync(home, { recursive: true });
    lock = acquireOwnedLock(path.join(home, 'editor-folder.lock'), { waitMs: 0, staleMs: 60_000, maxHoldMs: 60_000 });
  } catch {
    return { ran: false };
  }
  if (!lock.held) return { ran: false };
  try {
    return { ran: true, value: fn() };
  } finally {
    lock.release();
  }
}

/** How long a change waits for another one to the editor's folder to end, and how often it looks. */
const EDITOR_LOCK_WAIT_MS = 10_000;
const EDITOR_LOCK_LOOK_MS = 200;

async function underEditorLock<T>(c: PathCtx, fn: () => T): Promise<T | null> {
  const giveUpAt = Date.now() + EDITOR_LOCK_WAIT_MS;
  for (;;) {
    const result = withEditorLock(c, fn);
    if (result.ran) return result.value;
    if (Date.now() >= giveUpAt) return null;
    await new Promise((resolve) => setTimeout(resolve, EDITOR_LOCK_LOOK_MS));
  }
}

type Kind = 'missing' | 'link' | 'folder' | 'other';

/** What is at the editor's path: nothing, the old link, ccx's folder, or something ccx did not make. */
function kindOf(dir: string): Kind {
  let stat: Stats;
  try {
    stat = lstatSync(dir);
  } catch {
    return 'missing';
  }
  if (stat.isSymbolicLink()) return 'link';
  if (!stat.isDirectory()) return 'other';
  return readEditorRecord(dir) !== null ? 'folder' : 'other';
}

/** The account the editor is on: its folder's record, or, before the move off the old link, the account that link leads to. */
export function editorAccount(accounts: Array<{ name: string; dir: string }>, c: PathCtx = {}): string | null {
  if (isEditorFolder(c)) return readEditorRecord(editorFolderPath(c))?.account ?? null;
  return editorPointerAccount(accounts, c);
}

/**
 * The account the editor is on and whether its login there works, for
 * `ccx doctor`: a signed-out or refused login does not count as one.
 */
export function editorStanding(context: CliContext): { name: string; loggedIn: boolean } | null {
  const c = context.ctx;
  if (!isEditorFolder(c)) return editorTargetAccount(context);
  const name = readEditorRecord(editorFolderPath(c))?.account ?? null;
  if (name === null) return null;
  const text = readOrNull(editorFolderLogin(c));
  return {
    name,
    loggedIn: text !== null && usableLoginText(text) && !loginIsKnownDead(sha256Fingerprint(text), c),
  };
}

/**
 * Put the editor on the active account, after a switch. Never throws, and
 * returns at once to a caller that does not wait for it: a session's poll
 * calls it, where nothing would catch an error, and the editor following is not
 * worth ending a session.
 */
export function moveEditorToActive(context: CliContext): Promise<void> {
  return bringEditorUp(context, { move: true, setUp: false });
}

/** Bring the editor's folder into step with the user's ~/.claude, without moving its account. */
export function refreshEditor(context: CliContext): Promise<void> {
  return bringEditorUp(context, { move: false, setUp: false });
}

/** Set the editor up on its folder (`ccx editor on`, `ccx on`), made when it has none, on the active account. */
export function setUpEditor(context: CliContext): Promise<void> {
  return bringEditorUp(context, { move: true, setUp: true });
}

async function bringEditorUp(context: CliContext, how: { move: boolean; setUp: boolean }): Promise<void> {
  try {
    const c = context.ctx;
    const dir = editorFolderPath(c);
    let kind = kindOf(dir);
    if (kind === 'other') {
      // An empty folder left behind holds nothing and is taken over; anything
      // else there is not ccx's to touch.
      if (!emptyFolder(dir)) return;
      rmdirSync(dir);
      kind = 'missing';
    }
    if (kind === 'missing' && !how.setUp) return;
    if (kind === 'link') {
      const moved = await moveIntoFolder(context);
      if (moved !== 'moved') {
        // Still on the old link: it is pointed as before.
        if (how.move) syncEditorPointerIfEnabled(context);
        return;
      }
    }
    if (kind === 'missing' && !createEditorFolder(c)) return;
    await takeUpEditorRenewal(c, context.lookupOwner ? { lookupOwner: context.lookupOwner } : {});
    await underEditorLock(c, () => {
      refreshClaudeFolder(dir, c);
      pullProfileIntoEditor(c);
      if (how.move) moveEditorLogin(c);
    });
  } catch {
    /* the editor stays as it was until the next event brings it up */
  }
}

function emptyFolder(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/** Remove a half-made folder left by an attempt that failed, never through a link in it. */
function clearHalfMade(temp: string): void {
  if (existsSync(temp)) removeSessionDir(temp);
}

/** Make the editor's folder where there is none, whole or not at all. */
function createEditorFolder(c: PathCtx): boolean {
  const dir = editorFolderPath(c);
  const made = withEditorLock(c, () => {
    if (kindOf(dir) !== 'missing') return kindOf(dir) === 'folder';
    const temp = `${dir}.new`;
    clearHalfMade(temp);
    buildClaudeFolder(temp, c);
    writeEditorRecord(temp, { account: null, loginChangedAt: 0 });
    renameSync(temp, dir);
    return true;
  });
  return made.ran && made.value;
}

/** The folder's login as Claude reads it, or null when there is none or it cannot be read. */
function readOrNull(login: FolderLogin): string | null {
  try {
    return readFolderLogin(login);
  } catch {
    return null;
  }
}

/** The editor folder's login, as a move changes it (session/claude-folder moveFolderLogin). */
function editorLoginStore(login: FolderLogin): FolderLoginStore {
  let before: string | null = null;
  let remembered = false;
  let changed = false;
  const remember = (): void => {
    if (remembered) return;
    before = readOrNull(login);
    remembered = true;
  };
  return {
    install: (sourceFile) => {
      let text: string;
      try {
        text = readCredential(sourceFile);
      } catch {
        return false;
      }
      if (!usableLoginText(text)) return false;
      remember();
      writeFolderLogin(login, text);
      changed = true;
      return true;
    },
    scrub: () => {
      remember();
      removeFolderLogin(login);
      changed = true;
    },
    rollback: () => {
      if (!changed) return;
      if (before !== null) writeFolderLogin(login, before);
      else removeFolderLogin(login);
    },
    nudge: (now) => nudgeFolderLogin(login, now),
  };
}

/** Move the editor folder's login to the active account, in place, under its Claude's lock. The caller holds the editor lock. */
function moveEditorLogin(c: PathCtx): void {
  const dir = editorFolderPath(c);
  const active = getActive(c);
  const to = active ? getAccount(active, c) : undefined;
  if (!to) return;
  const record = readEditorRecord(dir) ?? { account: null, loginChangedAt: 0 };
  const login = editorFolderLogin(c);
  const now = readOrNull(login);
  // On it already, with a login: putting the profile's in again could put an
  // older copy of it over one the editor's Claude renewed.
  if (record.account === to.name && now !== null && usableLoginText(now)) return;
  const accounts = listAccounts(c);
  const leaving =
    record.account !== null && record.account !== to.name
      ? accounts.find((a) => a.name === record.account)
      : undefined;
  moveFolderLogin(dir, to.dir, c, editorLoginStore(login), {
    leaving: () => {
      if (leaving) saveEditorLoginHome(leaving, accounts, login, c);
    },
    installed: () => writeEditorRecord(dir, { account: to.name, loginChangedAt: Date.now() }),
  });
  appendEvent(configHome(c), `the editor is on ${to.name} now, in place`, Date.now(), {
    kind: 'editor-move',
    data: { from: record.account, to: to.name },
  });
}

/** How a change goes into one of the user's own files. */
const userFileWriter = (c: PathCtx): UserFileWriter => (file, plan) => writeUserFile(file, c, plan);

/**
 * Write `text`, a login of `account`'s that the profile does not have, into its
 * profile from a private copy, carrying it to the profiles sharing the one it
 * replaces, as a session's save-back does (writeAndCarry).
 */
function installFromText(account: Account, accounts: Account[], text: string, c: PathCtx, detail: string): boolean {
  const snapshot = path.join(configHome(c), `.editor-login.${process.pid}.tmp`);
  try {
    writeSecretFile(snapshot, text);
    let installed = false;
    writeAndCarry(account, accounts, carryTargets(account, accounts), () => {
      installed = installCredential(account.dir, snapshot);
    });
    if (installed) logCredentialEvent({ account: account.name, kind: 'installed', detail }, c);
    return installed;
  } catch {
    return false;
  } finally {
    rmSync(snapshot, { force: true });
  }
}

/** Whether `text` is a login worth keeping over `account`'s stored one: another, and newer, or the profile has none. */
function newerThanStored(text: string, account: Account): boolean {
  if (!usableLoginText(text)) return false;
  const fingerprint = loginTextFingerprint(text);
  if (fingerprint === null || fingerprint === credentialFingerprint(account.dir)) return false;
  return !hasUsableLogin(account.dir) || loginExpiresAt(text) > readExpiresAt(credentialPath(account.dir));
}

/**
 * As the editor moves off `leaving`, its login goes home when the editor's
 * Claude renewed it there, by the rule a terminal session's move uses: only to
 * the account the folder says it is signed in as (decideSaveBack).
 */
function saveEditorLoginHome(leaving: Account, accounts: Account[], login: FolderLogin, c: PathCtx): void {
  const text = readOrNull(login);
  if (text === null || !newerThanStored(text, leaving)) return;
  const decision = decideSaveBack({
    sessionEmail: sessionIdentityEmail(login.dir),
    ...(leaving.email ? { accountEmail: leaving.email } : {}),
    sessionIdentity: identityKey(login.dir),
    accountIdentity: identityKey(leaving.dir),
    accountName: leaving.name,
  });
  if (!decision.save) {
    appendEvent(configHome(c), `the editor: ${decision.reason}`, Date.now(), { kind: 'credential-sync' });
    return;
  }
  installFromText(leaving, accounts, text, c, 'the editor renewed this login; saved home as the editor moved off it');
}

/**
 * Carry a renewal made elsewhere into the editor's folder, by the rule a
 * running session takes one up by (decidePull): its account's profile holds a
 * newer login than the folder, and the folder is still signed in as that
 * account. The caller holds the editor lock.
 */
function pullProfileIntoEditor(c: PathCtx): void {
  const dir = editorFolderPath(c);
  const record = readEditorRecord(dir);
  if (!record?.account) return;
  const account = getAccount(record.account, c);
  if (!account) return;
  const login = editorFolderLogin(c);
  const mine = readOrNull(login);
  const theirs = readProfileLogin(account);
  if (theirs === null) return;
  const name = account.name;
  const ours = mine === null ? null : loginTextFingerprint(mine);
  const decision = decidePull({
    sessionUsable: mine !== null && usableLoginText(mine),
    profileUsable: usableLoginText(theirs),
    sameLineage: ours !== null && ours === loginTextFingerprint(theirs),
    sessionEmail: sessionIdentityEmail(dir),
    accountEmail: account.email ?? null,
    sessionExpiresAt: mine === null ? 0 : loginExpiresAt(mine),
    profileExpiresAt: loginExpiresAt(theirs),
  });
  if (!decision.pull) return;
  withCredentialLockIfFree(dir, () => {
    if (readOrNull(login) !== mine) return;
    writeFolderLogin(login, theirs);
    nudgeFolderLogin(login);
    logCredentialEvent(
      { account: name, kind: 'installed', detail: 'the stored login was renewed elsewhere; carried into the editor' },
      c,
    );
  });
}

/** An account's stored login as ccx reads it (its own Keychain item, or its file), or null. */
function readProfileLogin(account: Account): string | null {
  try {
    return readCredential(credentialPath(account.dir));
  } catch {
    return null;
  }
}

/** Whose a login is, by the API, asked from a private copy of it in ccx's folder. Null when it could not be asked. */
async function ownerOfLogin(
  text: string,
  c: PathCtx,
  lookupOwner?: (dir: string) => Promise<string | null>,
): Promise<string | null> {
  const probe = path.join(configHome(c), `.editor-owner.${process.pid}`);
  try {
    secureMkdir(probe);
    writeSecretFile(path.join(probe, CREDENTIALS_FILE), text);
    return await (lookupOwner ?? fetchTokenOwner)(probe);
  } catch {
    return null;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/** Logins of the editor's already asked about in this process, by folder: each is looked up once. */
const askedAbout = new Set<string>();

export type TakeUp = 'none' | 'taken' | 'unconfirmed';

/**
 * Take up a renewal the editor's Claude made in its folder into the profile of
 * the account it is on, as a terminal session's tick mirrors one home: only
 * when the folder holds a newer login than the profile, and only once the API
 * says whose it is, since a sign-in inside the editor changes the login before
 * the folder's record of who it is signed in as. 'unconfirmed' when the folder
 * holds a newer login that could not be checked yet: renewing the profile's
 * then would spend a token that renewal already retired.
 */
export async function takeUpEditorRenewal(
  c: PathCtx,
  options: { account?: string; lookupOwner?: (dir: string) => Promise<string | null> } = {},
): Promise<TakeUp> {
  try {
    if (!isEditorFolder(c)) return 'none';
    const dir = editorFolderPath(c);
    const record = readEditorRecord(dir);
    if (!record?.account) return 'none';
    if (options.account !== undefined && options.account !== record.account) return 'none';
    const accounts = listAccounts(c);
    const account = accounts.find((a) => a.name === record.account);
    if (!account) return 'none';
    const login = editorFolderLogin(c);
    const text = readOrNull(login);
    if (text === null || !newerThanStored(text, account)) return 'none';
    const fingerprint = loginTextFingerprint(text);
    if (fingerprint === null) return 'none';
    const asked = `${dir}|${fingerprint}`;
    if (askedAbout.has(asked)) return 'none';
    const owner = await ownerOfLogin(text, c, options.lookupOwner);
    if (owner === null) return 'unconfirmed';
    askedAbout.add(asked);
    const decision = decideSaveBack({
      confirmedOwner: owner,
      ...(account.email ? { accountEmail: account.email } : {}),
      sessionEmail: sessionIdentityEmail(dir),
      sessionIdentity: identityKey(dir),
      accountIdentity: identityKey(account.dir),
      accountName: account.name,
    });
    if (!decision.save) {
      appendEvent(configHome(c), `the editor: ${decision.reason}`, Date.now(), { kind: 'credential-sync' });
      return 'none';
    }
    // What was asked about, unless the editor's Claude has changed it since.
    if (folderLoginFingerprint(login) !== fingerprint) {
      askedAbout.delete(asked);
      return 'none';
    }
    return installFromText(account, accounts, text, c, 'the editor renewed this login; saved home') ? 'taken' : 'none';
  } catch {
    return 'none';
  }
}

/**
 * How long the move off the old link waits for editor chats started through it
 * to close. Each chat's Claude runs until its chat is closed, and a chat whose
 * first line is written in the instant of the swap keeps that start only in the
 * account's folder, while one already open carries on in the same file. A day
 * lets the chats open at an upgrade close in ordinary use; after it the move
 * goes ahead with them open, since waiting longer could mean never.
 */
export const EDITOR_MOVE_WAIT_MS = 24 * 60 * 60_000;
/** A login lock touched this recently is in use: Claude touches its own every 5 s. */
const LOCK_IN_USE_MS = 10_000;

/** Whether an editor chat's Claude started through the old link is running: its record, in the folder the link leads to. */
function editorChatsOpen(target: string): boolean {
  let names: string[];
  try {
    names = readdirSync(path.join(target, 'sessions'));
  } catch {
    return false;
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const record = JSON.parse(readFileSync(path.join(target, 'sessions', name), 'utf8')) as {
        pid?: unknown;
        entrypoint?: unknown;
      };
      if (record.entrypoint === 'claude-vscode' && typeof record.pid === 'number' && processIsAlive(record.pid)) {
        return true;
      }
    } catch {
      /* unreadable or gone: not one */
    }
  }
  return false;
}

/** Whether the move has waited EDITOR_MOVE_WAIT_MS for editor chats to close, starting the wait at the first look. */
function waitedLongEnough(c: PathCtx): boolean {
  const file = path.join(configHome(c), 'editor-move-held.json');
  try {
    const since = (JSON.parse(readFileSync(file, 'utf8')) as { since?: unknown }).since;
    if (typeof since === 'number') return Date.now() - since >= EDITOR_MOVE_WAIT_MS;
  } catch {
    /* the first look */
  }
  try {
    writeFileAtomic(file, `${JSON.stringify({ since: Date.now() })}\n`);
  } catch {
    /* looked at again next time */
  }
  return false;
}

/** The login in a Keychain item named after the editor's path, which Claude makes at its first save (#129). */
function firstItem(login: FolderLogin): string | null {
  for (const spelling of login.spellings) {
    try {
      const item = readKeychainCredential(spelling);
      if (item !== null) return item;
    } catch {
      /* the next spelling */
    }
  }
  return null;
}

type Moved = 'moved' | 'deferred' | 'failed';

/**
 * Move an install off the old link into the editor's own folder, at the same
 * path, losing nothing:
 *
 * 1. The new folder is built beside it with the code every session folder is.
 * 2. Its login is the one the editor's Claude runs on: on macOS a Keychain item
 *    named after the path when its Claude has saved a login there (#129),
 *    else the file the link led to. The item keeps its name, since the path
 *    does not change, so an open chat keeps its login. Whose it is, the API
 *    says, and it goes home to that account when newer, which gives back the
 *    login file that first save removed from a profile.
 * 3. Every account folder's chats, checkpoints and prompts are merged into
 *    ~/.claude by hard link, as ensureSharedDir merges a session's, and its own
 *    settings, memory, keybindings and Claude choices that are not the user's
 *    are kept in rescued/. Nothing in the account folders is moved or deleted.
 * 4. The link is swapped for the folder, then the merge is run again for
 *    anything written in between.
 *
 * Waits (deferred) while an editor chat started through the link is open, up
 * to EDITOR_MOVE_WAIT_MS, while a renewal through the link may be running, and
 * while a saved login's owner cannot be asked.
 */
async function moveIntoFolder(context: CliContext): Promise<Moved> {
  const c = context.ctx;
  const dir = editorFolderPath(c);
  const target = readTarget(dir);
  if (target !== null && editorChatsOpen(target) && !waitedLongEnough(c)) return 'deferred';
  const item = firstItem(editorFolderLogin(c));
  let owner: string | null = null;
  if (item !== null) {
    owner = await ownerOfLogin(item, c, context.lookupOwner);
    if (owner === null) return 'deferred';
  }
  const moved = withEditorLock(c, () => moveNow(c, target, item, owner));
  return moved.ran ? moved.value : 'deferred';
}

function moveNow(c: PathCtx, target: string | null, item: string | null, owner: string | null): Moved {
  const dir = editorFolderPath(c);
  // Looked at again under the lock: another ccx may have moved it, or the
  // editor's Claude renewed its login since it was asked about.
  if (kindOf(dir) !== 'link' || readTarget(dir) !== target) return kindOf(dir) === 'folder' ? 'moved' : 'deferred';
  if (item !== null && firstItem(editorFolderLogin(c)) !== item) return 'deferred';
  // A renewal through the link may be running, and its Claude would let go of the new folder's lock.
  if (target !== null && lockDirHeld(path.join(target, CREDENTIALS_LOCK_DIR), LOCK_IN_USE_MS)) return 'deferred';

  const accounts = listAccounts(c);
  const temp = `${dir}.new`;
  clearHalfMade(temp);
  buildClaudeFolder(temp, c);
  let account: Account | undefined;
  let text: string | null = null;
  if (item !== null) {
    const wanted = (owner ?? '').trim().toLowerCase();
    account = accounts.find((a) => a.email !== undefined && a.email.trim().toLowerCase() === wanted);
    text = item;
    if (account && newerThanStored(item, account)) {
      installFromText(
        account,
        accounts,
        item,
        c,
        'the editor kept this login in a Keychain item of its own; saved home as it moved into its own folder',
      );
    }
  } else if (target !== null) {
    const landsAt = path.resolve(target);
    account = accounts.find((a) => path.resolve(a.dir) === landsAt);
    try {
      text = readFileSync(path.join(target, CREDENTIALS_FILE), 'utf8');
    } catch {
      text = null;
    }
  }
  if (text !== null && usableLoginText(text)) writeSecretFile(path.join(temp, CREDENTIALS_FILE), text);
  applyAccountIdentity(temp, account?.dir ?? temp, c);
  snapshotStateBase(temp);
  writeEditorRecord(temp, { account: account?.name ?? null, loginChangedAt: Date.now() });

  const writer = userFileWriter(c);
  for (const a of accounts) {
    adoptFolderHistory(a.dir, a.name, c, writer, true);
    rescueStateChoices(a.dir, a.name, c);
  }
  if (!swapIn(dir, temp, target, c)) return 'failed';
  for (const a of accounts) adoptFolderHistory(a.dir, a.name, c, writer, false);
  rmSync(path.join(configHome(c), 'editor-move-held.json'), { force: true });
  appendEvent(
    configHome(c),
    `the editor moved into a folder of its own, on ${account?.name ?? 'no account yet'}: your chats, settings and memory are its own now`,
    Date.now(),
    { kind: 'editor-move', data: { from: target, to: account?.name ?? null } },
  );
  return 'moved';
}

/** Swap the old link for the folder built beside it, putting the link back when the folder cannot go in. */
function swapIn(dir: string, temp: string, target: string | null, c: PathCtx): boolean {
  try {
    removeTarget(dir);
  } catch {
    return false;
  }
  try {
    renameSync(temp, dir);
    return true;
  } catch {
    try {
      if (kindOf(dir) === 'missing') {
        if (target !== null) setTarget(dir, target, c.platform ? { platform: c.platform } : {});
        return false;
      }
      // Something made the path again in between: kept beside it, never removed.
      let stray = `${dir}.stray`;
      for (let i = 2; existsSync(stray); i++) stray = `${dir}.stray-${i}`;
      renameSync(dir, stray);
      renameSync(temp, dir);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Retire the editor's folder (`ccx editor off`, `ccx off`), losing nothing:
 * its login goes home when its Claude renewed it there, its settings, Claude
 * choices and the user's files it holds are handed back, and only then is it
 * removed, with the login wherever a Claude on it could read it: `spellings`,
 * read before the editor's setting went, name its Keychain items. The old link
 * is removed as before.
 */
export function retireEditor(context: CliContext, spellings?: string[]): boolean {
  const c = context.ctx;
  const dir = editorFolderPath(c);
  const kind = kindOf(dir);
  if (kind === 'link') {
    removeTarget(dir);
    return true;
  }
  if (kind !== 'folder') return true;
  const retired = withEditorLock(c, () => {
    const record = readEditorRecord(dir);
    const accounts = listAccounts(c);
    const login = spellings ? { dir, spellings } : editorFolderLogin(c);
    const account = record?.account ? accounts.find((a) => a.name === record.account) : undefined;
    if (account) saveEditorLoginHome(account, accounts, login, c);
    const synced = refreshClaudeFolder(dir, c);
    const handedBack =
      (synced.settings === 'synced' && synced.state === 'synced' && synced.files) ||
      (handBackOrRescue(dir, c) && returnSharedUserFiles(dir, c));
    if (!handedBack) return false;
    try {
      removeFolderLogin(login);
    } catch {
      return false;
    }
    return removeSessionDir(dir);
  });
  return retired.ran && retired.value;
}
