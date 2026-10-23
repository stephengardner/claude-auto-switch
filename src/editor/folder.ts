import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, existsSync, type Stats } from 'node:fs';
import path from 'node:path';
import { getAccount, listAccounts } from '../accounts/registry.js';
import type { Account } from '../accounts/registry.schema.js';
import { getActive } from '../state/active.js';
import { configHome, type PathCtx } from '../config/paths.js';
import { readTarget, removeTarget, setTarget } from '../daemon/junction.js';
import { acquireOwnedLock, CREDENTIALS_LOCK_DIR, lockDirHeld, lockDirSteps, withCredentialLockIfFree } from '../claude/locks.js';
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
import { readKeychainItem } from '../accounts/keychain-view.js';
import { loginExpiresAt, readExpiresAt } from '../usage/token-expiry.js';
import { loginIsKnownDead } from '../usage/dead-login-store.js';
import { sha256Fingerprint } from '../util/fingerprint.js';
import { decideSaveBack } from '../accounts/save-back.js';
import { decidePull } from '../accounts/credential-sync.js';
import { writeAndCarry } from '../accounts/shared-login.js';
import { carryTargets } from '../accounts/duplicate-guard.js';
import { fetchTokenOwner, OWNER_LOOKUP_MS } from '../accounts/identity-check.js';
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
import {
  adoptFolderHistory,
  rescueText,
  returnOwnFolders,
  returnSharedUserFiles,
  type UserFileWriter,
} from '../session/shared-root.js';
import { removeSessionDir } from '../session/session-dir.js';
import { processIsAlive } from '../session/lease.js';
import { editorPointerAccount, editorTargetAccount, syncEditorPointerIfEnabled } from './junction.js';
import {
  editorFolderLogin,
  editorFolderPath,
  editorsOnFolder,
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
function withEditorLock<T>(c: PathCtx, fn: () => T, waitMs = 0): { ran: true; value: T } | { ran: false } {
  let lock: ReturnType<typeof acquireOwnedLock>;
  try {
    const home = configHome(c);
    mkdirSync(home, { recursive: true });
    lock = acquireOwnedLock(path.join(home, 'editor-folder.lock'), { waitMs, staleMs: 60_000, maxHoldMs: 60_000 });
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
export function moveEditorToActive(context: CliContext, from: { session?: boolean } = {}): Promise<EditorUp> {
  // From a running session's thread, which relays Claude's terminal, ccx's
  // own locks are tried once and the refresh left to the next event.
  return bringEditorUp(context, { move: true, setUp: false, ...(from.session ? { lockWaitMs: 0 } : {}) });
}

/** Bring the editor's folder into step with the user's ~/.claude, without moving its account. */
export function refreshEditor(context: CliContext): Promise<EditorUp> {
  return bringEditorUp(context, { move: false, setUp: false });
}

/** Set the editor up on its folder (`ccx editor on`, `ccx on`), made when it has none, on the active account. */
export function setUpEditor(context: CliContext): Promise<EditorUp> {
  return bringEditorUp(context, { move: true, setUp: true });
}

/**
 * What bringing the editor up came to: ready; working meanwhile on what it had
 * (the old link pointed at the active account, or its folder on the account
 * before a move ccx makes at its next event); or not set up, and why.
 */
export type EditorUp = { state: 'ready' } | { state: 'meanwhile'; why: string } | { state: 'not-ready'; why: string };

/** How soon a move that found its Claude's locks taken tries again, and for how long, before its next event. */
const EDITOR_MOVE_LOOK_MS = 200;
const EDITOR_MOVE_RETRY_MS = 10_000;

async function bringEditorUp(
  context: CliContext,
  how: { move: boolean; setUp: boolean; lockWaitMs?: number },
): Promise<EditorUp> {
  const c = context.ctx;
  const dir = editorFolderPath(c);
  try {
    if (retirePendingSince(c) !== null) {
      // Turned off with an editor chat open in it, or with something it holds
      // not handed back: retired once it can be, and kept in step until then,
      // for a chat still running on it.
      if (editorsOnFolder(c).length > 0) clearRetirePending(c);
      else if (retireEditor(context) === 'retired') {
        return { state: 'not-ready', why: 'no editor is set to the folder, and ccx has retired it' };
      }
    }
    let kind = kindOf(dir);
    if (kind === 'other') {
      if (!isDirectory(dir)) return { state: 'not-ready', why: `${dir} is not a folder; move it away and run \`ccx editor on\` again` };
      if (emptyFolder(dir)) {
        rmdirSync(dir);
        kind = 'missing';
      } else {
        const taken = await takeOverFolder(context);
        if (taken !== 'moved') {
          return {
            state: 'not-ready',
            why:
              taken === 'deferred'
                ? `${dir} is a folder ccx did not make; ccx takes it over once no editor chat is open in it and whose login it holds can be asked`
                : `${dir} is a folder ccx did not make, and it could not be taken over`,
          };
        }
        kind = 'folder';
      }
    }
    if (kind === 'missing' && !how.setUp) return { state: 'not-ready', why: 'the editor has no folder yet' };
    if (kind === 'link') {
      const moved = await moveIntoFolder(context);
      if (moved !== 'moved') {
        // Still on the old link: it is pointed as before.
        if (how.move) syncEditorPointerIfEnabled(context);
        return {
          state: 'meanwhile',
          why: 'on the old link to the active account for now; ccx moves it into its own folder once the editor chats started through it have closed',
        };
      }
    }
    if (kind === 'missing' && !createEditorFolder(c)) return { state: 'not-ready', why: `${dir} could not be made` };
    await takeUpEditorRenewal(c, {
      ...(context.lookupOwner ? { lookupOwner: context.lookupOwner } : {}),
      ...(how.lockWaitMs !== undefined ? { lockWaitMs: how.lockWaitMs } : {}),
    });
    const refreshed = await underEditorLock(c, () => {
      finishLateMerge(c);
      refreshClaudeFolder(dir, c, {}, how.lockWaitMs);
      pullProfileIntoEditor(c);
      return true;
    });
    if (refreshed === null) return { state: 'not-ready', why: 'another ccx was changing the folder; run it again' };
    await underEditorLock(c, () => finishTakeOver(c));
    if (!how.move && !movePending(c)) return { state: 'ready' };
    return await moveWithClaudesLocks(context, how.lockWaitMs);
  } catch (error) {
    return { state: 'not-ready', why: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Move the editor's login to the active account, never past its Claude's
 * locks: while they are taken it looks again every EDITOR_MOVE_LOOK_MS for
 * EDITOR_MOVE_RETRY_MS, without holding up the thread, and then leaves the move
 * to ccx's next event (movePending).
 */
async function moveWithClaudesLocks(context: CliContext, lockWaitMs?: number): Promise<EditorUp> {
  const c = context.ctx;
  const giveUpAt = Date.now() + (context.editorMoveRetryMs ?? EDITOR_MOVE_RETRY_MS);
  for (;;) {
    const moved = await underEditorLock(c, () => moveEditorLogin(c, lockWaitMs));
    if (moved === null) return { state: 'not-ready', why: 'another ccx was changing the folder; run it again' };
    if (moved !== 'deferred') {
      clearMovePending(c);
      return { state: 'ready' };
    }
    markMovePending(c);
    if (Date.now() >= giveUpAt) {
      const on = readEditorRecord(editorFolderPath(c))?.account ?? null;
      const why = "the editor's Claude was using its login, and ccx moves it at its next event";
      return on === null ? { state: 'not-ready', why } : { state: 'meanwhile', why: `on ${on} for now: ${why}` };
    }
    await new Promise((resolve) => setTimeout(resolve, EDITOR_MOVE_LOOK_MS));
  }
}

/** Where ccx notes a move of the editor's login it could not make yet, for its next event. */
const movePendingFile = (c: PathCtx): string => path.join(configHome(c), 'editor-move-pending.json');
const movePending = (c: PathCtx): boolean => existsSync(movePendingFile(c));
function markMovePending(c: PathCtx): void {
  try {
    if (!movePending(c)) writeFileAtomic(movePendingFile(c), `${JSON.stringify({ since: Date.now() })}\n`);
  } catch {
    /* the next switch moves it all the same */
  }
}
const clearMovePending = (c: PathCtx): void => rmSync(movePendingFile(c), { force: true });

function isDirectory(dir: string): boolean {
  try {
    return lstatSync(dir).isDirectory();
  } catch {
    return false;
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

/** The folder's login as Claude reads it, or null when there is none or it cannot be read: for showing, never for deciding. */
function readOrNull(login: FolderLogin): string | null {
  try {
    return readFolderLogin(login);
  } catch {
    return null;
  }
}

/**
 * The editor folder's login, as a move changes it (session/claude-folder
 * moveFolderLogin). What it held is read before anything is written, and a
 * read that fails stops the move there: put back as "nothing", it would be
 * removed by a rollback.
 */
function editorLoginStore(login: FolderLogin): FolderLoginStore {
  let before: string | null = null;
  let remembered = false;
  let changed = false;
  const remember = (): void => {
    if (remembered) return;
    before = readFolderLogin(login);
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

/**
 * Move the editor folder's login to the active account, in place, only while
 * holding both locks its Claude takes: one mid-renewal would put its renewal
 * of the old account on top of the new login, or throw it away, and either way
 * that account's login is lost. 'deferred' when either is taken. The caller
 * holds the editor lock.
 */
function moveEditorLogin(c: PathCtx, lockWaitMs?: number): 'moved' | 'deferred' | 'not-needed' {
  const dir = editorFolderPath(c);
  const active = getActive(c);
  const to = active ? getAccount(active, c) : undefined;
  if (!to) return 'not-needed';
  const record = readEditorRecord(dir) ?? { account: null, loginChangedAt: 0 };
  const login = editorFolderLogin(c);
  let now: string | null;
  try {
    now = readFolderLogin(login);
  } catch {
    return 'deferred'; // a Keychain that could not be read is not one with nothing in it
  }
  // On it already, with a login: putting the profile's in again could put an
  // older copy of it over one the editor's Claude renewed.
  if (record.account === to.name && now !== null && usableLoginText(now)) return 'not-needed';
  const accounts = listAccounts(c);
  const leaving =
    record.account !== null && record.account !== to.name
      ? accounts.find((a) => a.name === record.account)
      : undefined;
  let moved: boolean;
  try {
    moved = moveFolderLogin(dir, to.dir, c, editorLoginStore(login), {
      leaving: () => {
        if (leaving) saveEditorLoginHome(leaving, accounts, login, c, lockWaitMs);
      },
      installed: () => writeEditorRecord(dir, { account: to.name, loginChangedAt: Date.now() }),
      onlyUnderClaudesLocks: true,
    });
  } catch {
    return 'deferred'; // rolled back, or stopped before anything was written
  }
  if (!moved) return 'deferred';
  appendEvent(configHome(c), `the editor is on ${to.name} now, in place`, Date.now(), {
    kind: 'editor-move',
    data: { from: record.account, to: to.name },
  });
  return 'moved';
}

/** How a change goes into one of the user's own files. */
const userFileWriter = (c: PathCtx): UserFileWriter => (file, plan) => writeUserFile(file, c, plan);

/**
 * Write `text`, a login of `account`'s that the profile does not have, into its
 * profile from a private copy, carrying it to the profiles sharing the one it
 * replaces, as a session's save-back does (writeAndCarry). False, never a
 * throw, when it could not be written. `lockWaitMs`: how long a profile sharing
 * the login is waited for; a running session's thread passes 0.
 */
function installFromText(
  account: Account,
  accounts: Account[],
  text: string,
  c: PathCtx,
  detail: string,
  lockWaitMs?: number,
): boolean {
  const snapshot = path.join(configHome(c), `.editor-login.${process.pid}.tmp`);
  try {
    writeSecretFile(snapshot, text);
    let installed = false;
    writeAndCarry(
      account,
      accounts,
      carryTargets(account, accounts),
      () => {
        installed = installCredential(account.dir, snapshot);
      },
      lockWaitMs !== undefined
        ? { lock: (dir: string) => lockDirSteps(path.join(dir, CREDENTIALS_LOCK_DIR), { waitMs: lockWaitMs }) }
        : {},
    );
    if (installed) logCredentialEvent({ account: account.name, kind: 'installed', detail }, c);
    return installed;
  } catch {
    return false;
  } finally {
    try {
      rmSync(snapshot, { force: true });
    } catch {
      /* something not ccx's at that path stays, and the answer stands */
    }
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
function saveEditorLoginHome(
  leaving: Account,
  accounts: Account[],
  login: FolderLogin,
  c: PathCtx,
  lockWaitMs?: number,
): void {
  // Throws when it cannot be read, or not saved home: what it holds may be a
  // renewal only it has, which a move would then write over.
  const text = readFolderLogin(login);
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
  if (!installFromText(leaving, accounts, text, c, 'the editor renewed this login; saved home as the editor moved off it', lockWaitMs)) {
    throw new Error(`the editor's renewal of ${leaving.name}'s login could not be saved home`);
  }
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
  let mine: string | null;
  try {
    mine = readFolderLogin(login);
  } catch {
    return; // what it holds may be newer than the profile's
  }
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
    if (readFolderLogin(login) !== mine) return;
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

/**
 * Whose a login is, by the API, asked from a private copy of it in ccx's
 * folder. Null when it could not be asked, or no answer came within
 * OWNER_LOOKUP_MS: a session start, the usage refresh and a switch wait on it.
 */
async function ownerOfLogin(
  text: string,
  c: PathCtx,
  lookupOwner?: (dir: string) => Promise<string | null>,
): Promise<string | null> {
  const probe = path.join(configHome(c), `.editor-owner.${process.pid}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    secureMkdir(probe);
    writeSecretFile(path.join(probe, CREDENTIALS_FILE), text);
    const lookup = lookupOwner ?? ((dir: string) => fetchTokenOwner(dir, fetch, OWNER_LOOKUP_MS));
    const unanswered = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), OWNER_LOOKUP_MS);
    });
    return await Promise.race([lookup(probe), unanswered]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
 * holds a newer login that could not be checked, or saved home, yet, or when
 * what it holds could not be read: renewing the profile's then could spend a
 * token that renewal already retired.
 */
export async function takeUpEditorRenewal(
  c: PathCtx,
  options: {
    account?: string;
    lookupOwner?: (dir: string) => Promise<string | null>;
    /** How long a profile sharing the login is waited for as a renewal is saved home; 0 from a running session. */
    lockWaitMs?: number;
  } = {},
): Promise<TakeUp> {
  // Once the folder is on this account, a failure to tell what it holds is no answer that it holds nothing.
  let mayHold = false;
  let asked: string | null = null;
  try {
    if (!isEditorFolder(c)) return 'none';
    const dir = editorFolderPath(c);
    const record = readEditorRecord(dir);
    if (!record?.account) return 'none';
    if (options.account !== undefined && options.account !== record.account) return 'none';
    const accounts = listAccounts(c);
    const account = accounts.find((a) => a.name === record.account);
    if (!account) return 'none';
    mayHold = true;
    const login = editorFolderLogin(c);
    const text = readFolderLogin(login);
    if (text === null || !newerThanStored(text, account)) return 'none';
    const fingerprint = loginTextFingerprint(text);
    if (fingerprint === null) return 'none';
    if (askedAbout.has(`${dir}|${fingerprint}`)) return 'none';
    asked = `${dir}|${fingerprint}`;
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
    const still = readFolderLogin(login);
    if (still === null || loginTextFingerprint(still) !== fingerprint) {
      askedAbout.delete(asked);
      return 'none';
    }
    if (installFromText(account, accounts, text, c, 'the editor renewed this login; saved home', options.lockWaitMs)) return 'taken';
    // Asked about again at the next look; meanwhile nothing renews the token that renewal retired.
    askedAbout.delete(asked);
    return 'unconfirmed';
  } catch {
    if (asked !== null) askedAbout.delete(asked);
    return mayHold ? 'unconfirmed' : 'none';
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

/**
 * Whether an editor chat's Claude is running on `folder`: its record in the
 * folder's `sessions`. ccx's own folder links that to ~/.claude/sessions, where
 * every Claude's record is and none says which folder it runs on, so any
 * editor chat there counts, but for one started at or after `startedBefore`
 * (an editor setting no longer naming the folder by then).
 */
function editorChatsOpen(folder: string, startedBefore?: number): boolean {
  let names: string[];
  try {
    names = readdirSync(path.join(folder, 'sessions'));
  } catch {
    return false;
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const record = JSON.parse(readFileSync(path.join(folder, 'sessions', name), 'utf8')) as {
        pid?: unknown;
        entrypoint?: unknown;
        startedAt?: unknown;
      };
      if (record.entrypoint !== 'claude-vscode' || typeof record.pid !== 'number' || !processIsAlive(record.pid)) continue;
      if (startedBefore !== undefined && typeof record.startedAt === 'number' && record.startedAt >= startedBefore) continue;
      return true;
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
      const item = readKeychainItem(spelling);
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
  const chatsOpen = target !== null && editorChatsOpen(target);
  if (chatsOpen && !waitedLongEnough(c)) return 'deferred';
  const item = firstItem(editorFolderLogin(c));
  let owner: string | null = null;
  if (item !== null) {
    owner = await ownerOfLogin(item, c, context.lookupOwner);
    if (owner === null) return 'deferred';
  }
  const moved = withEditorLock(c, () => moveNow(c, target, item, owner, chatsOpen));
  return moved.ran ? moved.value : 'deferred';
}

/** Where the move remembers the folder the old link led to while an editor chat started through it is still open. */
const lateMergeFile = (c: PathCtx): string => path.join(configHome(c), 'editor-move-late.json');

/**
 * One more merge of the account folders' history, after a move whose own merge
 * failed, or once the editor chats that were open at the move have all closed.
 * Such a chat writes by path into the folder that is now at the editor's path,
 * but a file it kept open, such as its prompt history, goes on growing where
 * the link led, and those lines are copied over, not shared by a hard link.
 * The note stays until every account folder has merged. Never throws: the
 * editor's switch comes after it. The caller holds the editor lock.
 */
function finishLateMerge(c: PathCtx): void {
  try {
    let target: unknown;
    try {
      target = (JSON.parse(readFileSync(lateMergeFile(c), 'utf8')) as { target?: unknown }).target;
    } catch {
      return;
    }
    if (typeof target === 'string' && editorChatsOpen(target)) return;
    const writer = userFileWriter(c);
    let merged = true;
    for (const a of listAccounts(c)) {
      if (!adoptFolderHistory(a.dir, a.name, c, writer, false)) merged = false;
    }
    if (merged) rmSync(lateMergeFile(c), { force: true });
  } catch {
    /* the note stays, for the next refresh */
  }
}

function moveNow(
  c: PathCtx,
  target: string | null,
  item: string | null,
  owner: string | null,
  chatsOpen: boolean,
): Moved {
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
  let merged = true;
  for (const a of accounts) {
    if (!adoptFolderHistory(a.dir, a.name, c, writer, false)) merged = false;
  }
  rmSync(path.join(configHome(c), 'editor-move-held.json'), { force: true });
  if (chatsOpen || !merged) {
    try {
      writeFileAtomic(lateMergeFile(c), `${JSON.stringify({ target })}\n`);
    } catch {
      /* the account folders keep what they hold; a later move cannot merge it */
    }
  }
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
 * choices and the user's files it holds are handed back, any folder it holds
 * of its own rather than by link is merged into ~/.claude, and only then is it
 * removed, with the login wherever a Claude on it could read it: `spellings`,
 * read before the editor's setting went, name its Keychain items. The old link
 * is removed as before.
 *
 * 'held' while an editor chat that may have been started through it is open:
 * its Claude goes on writing in the folder, and would make it again once
 * removed. ccx notes it, and a later event retires it once those chats have
 * closed. 'kept' when what it holds could not all be handed back; a later event
 * tries again.
 */
export function retireEditor(context: CliContext, spellings?: string[]): 'retired' | 'held' | 'kept' {
  const c = context.ctx;
  const dir = editorFolderPath(c);
  const kind = kindOf(dir);
  if (kind === 'link') {
    removeTarget(dir);
    clearRetirePending(c);
    return 'retired';
  }
  if (kind !== 'folder') {
    clearRetirePending(c);
    return 'retired';
  }
  const since = retirePendingSince(c) ?? Date.now();
  if (editorChatsOpen(dir, since)) {
    markRetirePending(c, since);
    return 'held';
  }
  const retired = withEditorLock(c, () => {
    const record = readEditorRecord(dir);
    const accounts = listAccounts(c);
    // The record holds those of settings already gone (rememberEditorSpellings).
    const known = [...new Set([...(spellings ?? []), ...editorFolderLogin(c).spellings])];
    const login = { dir, spellings: known };
    const account = record?.account ? accounts.find((a) => a.name === record.account) : undefined;
    try {
      if (account) saveEditorLoginHome(account, accounts, login, c);
    } catch {
      return false; // its login could not be read, so it may be a renewal only it has
    }
    const synced = refreshClaudeFolder(dir, c);
    const handedBack =
      (synced.settings === 'synced' && synced.state === 'synced' && synced.files) ||
      (handBackOrRescue(dir, c) && returnSharedUserFiles(dir, c));
    if (!handedBack || !returnOwnFolders(dir, 'editor', c)) return false;
    try {
      removeFolderLogin(login);
    } catch {
      return false;
    }
    return removeSessionDir(dir);
  });
  if (retired.ran && retired.value) {
    clearRetirePending(c);
    return 'retired';
  }
  markRetirePending(c, since);
  return 'kept';
}

/** Where ccx notes a retirement of the editor's folder still to come, and since when its setting is gone. */
const retireFile = (c: PathCtx): string => path.join(configHome(c), 'editor-retire.json');

function retirePendingSince(c: PathCtx): number | null {
  try {
    const since = (JSON.parse(readFileSync(retireFile(c), 'utf8')) as { since?: unknown }).since;
    return typeof since === 'number' ? since : null;
  } catch {
    return null;
  }
}

function markRetirePending(c: PathCtx, since: number): void {
  try {
    if (retirePendingSince(c) === null) writeFileAtomic(retireFile(c), `${JSON.stringify({ since })}\n`);
  } catch {
    /* `ccx editor off` again retires it */
  }
}

const clearRetirePending = (c: PathCtx): void => rmSync(retireFile(c), { force: true });

/**
 * Keep in the folder's record how editor settings spell the folder, before
 * `ccx editor off` takes one away: on macOS the Keychain item named after that
 * text may hold a login nothing else names, which the retirement must take home
 * and remove, whether it runs now or after the last editor goes. False when it
 * could not be kept.
 */
export function rememberEditorSpellings(context: CliContext, spellings: string[]): boolean {
  const c = context.ctx;
  const dir = editorFolderPath(c);
  if (kindOf(dir) !== 'folder') return true;
  const kept = withEditorLock(
    c,
    () => {
      const record = readEditorRecord(dir);
      if (!record) return true;
      const known = [...new Set([...(record.spellings ?? []), ...spellings])];
      if (known.length === (record.spellings ?? []).length) return true;
      try {
        writeEditorRecord(dir, { ...record, spellings: known });
        return true;
      } catch {
        return false;
      }
    },
    EDITOR_LOCK_WAIT_MS,
  );
  return kept.ran && kept.value;
}

/**
 * Take over a folder at the editor's path that ccx did not make, losing
 * nothing. An editor's Claude makes one when it runs on that path with ccx's
 * folder gone. Its chats, checkpoints and prompts go into ~/.claude by the
 * move's rule (adoptFolderHistory, returnOwnFolders), its own settings, memory,
 * keybindings and Claude choices that are not the user's into rescued/, and the
 * login its Claude ran on home to its account once the API says whose it is
 * (kept in rescued/ when it is no account of ccx's). Then ccx's folder is built
 * in its place, and the one taken over is kept aside until a later event merges
 * it once more and removes it (finishTakeOver). Waits while an editor chat in
 * it is open, or whose its login is cannot be asked.
 */
async function takeOverFolder(context: CliContext): Promise<Moved> {
  const c = context.ctx;
  const dir = editorFolderPath(c);
  if (editorChatsOpen(dir)) return 'deferred';
  let text: string | null = null;
  try {
    text = readFolderLogin(editorFolderLogin(c));
  } catch {
    return 'deferred';
  }
  let owner: string | null = null;
  if (text !== null && usableLoginText(text)) {
    owner = await ownerOfLogin(text, c, context.lookupOwner);
    if (owner === null) return 'deferred';
  }
  const taken = withEditorLock(c, () => takeOverNow(c, text, owner));
  return taken.ran ? taken.value : 'deferred';
}

function takeOverNow(c: PathCtx, text: string | null, owner: string | null): Moved {
  const dir = editorFolderPath(c);
  // Looked at again under the lock: another ccx may have taken it over, or its Claude come back.
  if (kindOf(dir) !== 'other' || !isDirectory(dir)) return kindOf(dir) === 'folder' ? 'moved' : 'deferred';
  if (editorChatsOpen(dir) || readFolderLogin(editorFolderLogin(c)) !== text) return 'deferred';
  const accounts = listAccounts(c);
  const wanted = (owner ?? '').trim().toLowerCase();
  const account =
    owner === null ? undefined : accounts.find((a) => a.email !== undefined && a.email.trim().toLowerCase() === wanted);
  if (text !== null && usableLoginText(text)) {
    if (account) {
      if (newerThanStored(text, account)) {
        installFromText(account, accounts, text, c, 'the editor ran on this login in a folder ccx did not make; saved home');
      }
    } else if (!rescueText(text, 'editor-login.json', c)) {
      return 'failed';
    }
  }
  const writer = userFileWriter(c);
  adoptFolderHistory(dir, 'editor', c, writer, true);
  rescueStateChoices(dir, 'editor', c);
  returnOwnFolders(dir, 'editor', c);

  const temp = `${dir}.new`;
  clearHalfMade(temp);
  buildClaudeFolder(temp, c);
  if (account && text !== null && usableLoginText(text)) writeSecretFile(path.join(temp, CREDENTIALS_FILE), text);
  applyAccountIdentity(temp, account?.dir ?? temp, c);
  snapshotStateBase(temp);
  writeEditorRecord(temp, { account: account?.name ?? null, loginChangedAt: Date.now() });
  let aside = `${dir}.taken-over`;
  for (let i = 2; existsSync(aside); i++) aside = `${dir}.taken-over-${i}`;
  try {
    renameSync(dir, aside);
  } catch {
    clearHalfMade(temp);
    return 'deferred';
  }
  try {
    renameSync(temp, dir);
  } catch {
    try {
      renameSync(aside, dir);
    } catch {
      /* the folder stays aside, noted below, and nothing in it is lost */
    }
    clearHalfMade(temp);
    if (existsSync(dir)) return 'failed';
  }
  noteTakenOver(c, aside);
  appendEvent(
    configHome(c),
    `ccx took over a folder at the editor's path that it had not made, on ${account?.name ?? 'no account yet'}: its chats and files are in your ~/.claude`,
    Date.now(),
    { kind: 'editor-move', data: { from: aside, to: account?.name ?? null } },
  );
  return kindOf(dir) === 'folder' ? 'moved' : 'failed';
}

/** Where ccx notes the folders it took over, kept aside until a later event has merged them once more. */
const takenOverFile = (c: PathCtx): string => path.join(configHome(c), 'editor-taken-over.json');

function takenOver(c: PathCtx): string[] {
  try {
    const folders = (JSON.parse(readFileSync(takenOverFile(c), 'utf8')) as { folders?: unknown }).folders;
    return Array.isArray(folders) ? folders.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

function noteTakenOver(c: PathCtx, folder: string): void {
  try {
    writeFileAtomic(takenOverFile(c), `${JSON.stringify({ folders: [...new Set([...takenOver(c), folder])] })}\n`);
  } catch {
    /* the folder stays aside, at a path its name says */
  }
}

/**
 * Merge each folder taken over once more, for anything written in it between
 * the first merge and the swap, and remove it once that is whole and no editor
 * chat is open in it. Never throws. The caller holds the editor lock.
 */
function finishTakeOver(c: PathCtx): void {
  try {
    const folders = takenOver(c);
    if (folders.length === 0) return;
    const writer = userFileWriter(c);
    const left = folders.filter((folder) => {
      if (!existsSync(folder)) return false;
      if (editorChatsOpen(folder)) return true;
      // Its own files kept aside again too: one whose first keeping failed would go with the folder.
      const merged =
        adoptFolderHistory(folder, 'editor', c, writer, true) &&
        rescueStateChoices(folder, 'editor', c) &&
        returnOwnFolders(folder, 'editor', c);
      return !(merged && removeSessionDir(folder));
    });
    if (left.length === 0) rmSync(takenOverFile(c), { force: true });
    else writeFileAtomic(takenOverFile(c), `${JSON.stringify({ folders: left })}\n`);
  } catch {
    /* the note stays, for the next refresh */
  }
}
