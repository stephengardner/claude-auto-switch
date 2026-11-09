import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_LOGIN } from './default-login-item.js';
import { keychainBlocking, keychainOnTimers, type KeychainIo } from './keychain-view.js';
import {
  CREDENTIALS_FILE,
  DEFAULT_LOGIN_MARKER,
  defaultLoginLock,
  holdsDefaultLogin,
  keptAside,
  readDefaultLoginMarker,
  writeDefaultLoginMarker,
} from './credential-storage.js';
import { previousCredentialPath } from './credential-vault.js';
import { MCP_OAUTH_KEY, parkMcpLogins } from './mcp-logins.js';
import { getAccount, listAccounts } from './registry.js';
import type { Account } from './registry.schema.js';
import { getActive } from '../state/active.js';
import { CREDENTIALS_LOCK_DIR, lockDirSteps, type LockHandle } from '../claude/locks.js';
import { configHome, type PathCtx } from '../config/paths.js';
import { defaultClaudeJsonPath } from '../daemon/reference-config.js';
import { mergeInto } from '../session/write-back.js';
import { writeSecretFile } from '../util/secret-file.js';
import { call, runBlocking, runOnTimers, type Steps } from '../util/steps.js';
import { thrownReason } from '../util/thrown-reason.js';

/**
 * Chat mode (macOS and Linux). A Claude run with no CLAUDE_CONFIG_DIR, on plain
 * ~/.claude, reads Claude's own default login (default-login-item.ts DEFAULT_LOGIN): an
 * editor not set up with `ccx editor on`, a `claude` another program starts or
 * one started by its full path. Moving the active account's login into that
 * default login switches those chats mid-chat, keeping their settings and the
 * MCP sign-ins they hold, which stay in the default login.
 *
 * The login is MOVED, not copied, so its refresh token has one holder: the
 * profile is marked (DEFAULT_LOGIN_MARKER), ccx reads and writes its saved
 * login through the default login from then on (credential-storage), and the
 * chats renew it (oauth-refresh). A move is made only while ccx holds the
 * locks Claude takes around that login and its state, each tried once, and is
 * undone step by step when a step fails.
 */

const FLAG = 'default-login.on';
/** The login Claude had before chat mode first moved one in, put back by `ccx chat off`. */
const BACKUP = 'default-login.original.json';
/** How long a follow that finds a lock taken looks again, and how often, before leaving the move to the next switch. */
const RETRY_MS = 10_000;
const LOOK_MS = 200;

export function defaultLoginEnabled(c: PathCtx = {}): boolean {
  try {
    return existsSync(path.join(configHome(c), FLAG));
  } catch {
    return false;
  }
}

export type DefaultLoginMove =
  | { state: 'moved' | 'already'; account: string }
  /** A lock the move needs is taken (a renewal, Claude saving its state): nothing was changed; try again shortly. */
  | { state: 'busy'; why: string }
  /** Nothing to move, or not here. */
  | { state: 'skipped'; why: string };

export type DefaultLoginFollow = DefaultLoginMove | { state: 'failed'; why: string };

/** A lock taken, or a step that met one: what it changed was undone, and a later try may go through. */
class LockTaken extends Error {}

type Undo = Array<() => Steps<void>>;

const onLinux = (c: PathCtx): boolean => (c.platform ?? process.platform) === 'linux';
const supported = (c: PathCtx): boolean => onLinux(c) || (c.platform ?? process.platform) === 'darwin';

function asObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const loginOf = (text: string | null): unknown => asObject(text)?.claudeAiOauth;

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function holderOf(accounts: Account[]): Account | undefined {
  return accounts.find((a) => holdsDefaultLogin(a.dir));
}

/** A profile's own login: its Keychain item on macOS, its .credentials.json on Linux. */
function* readOwnSteps(dir: string, c: PathCtx, io: KeychainIo): Steps<string | null> {
  if (!onLinux(c)) return yield* call(() => io.read(dir));
  try {
    return readFileSync(path.join(dir, CREDENTIALS_FILE), 'utf8').trim() || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw error;
  }
}

function* writeOwnSteps(dir: string, text: string, c: PathCtx, io: KeychainIo): Steps<void> {
  if (onLinux(c)) writeSecretFile(path.join(dir, CREDENTIALS_FILE), text);
  else yield* call(() => io.write(dir, text));
}

function* removeOwnSteps(dir: string, c: PathCtx, io: KeychainIo): Steps<void> {
  if (onLinux(c)) rmSync(path.join(dir, CREDENTIALS_FILE), { force: true });
  else yield* call(() => io.remove(dir));
}

/** Put the default login back as it was; with none before, the item the move made goes (Linux keeps the file). */
function* putBackDefault(before: string | null, io: KeychainIo): Steps<void> {
  if (before !== null) yield* call(() => io.write(DEFAULT_LOGIN, before));
  else yield* call(() => io.remove(DEFAULT_LOGIN));
}

/** Every lock tried once, in this order, and all held or none. */
function* takeLocks(
  lockDirs: string[],
): Steps<{ ok: true; held: LockHandle[] } | { ok: false; busy: boolean; why: string }> {
  const held: LockHandle[] = [];
  for (const lockDir of lockDirs) {
    const lock = yield* lockDirSteps(lockDir, { waitMs: 0 });
    if (!lock.held) {
      lock.release();
      for (const taken of held) taken.release();
      return lock.unusable
        ? { ok: false, busy: false, why: `${lockDir} could not be created (${lock.unusable})` }
        : { ok: false, busy: true, why: `${lockDir} is taken` };
    }
    held.push(lock);
  }
  return { ok: true, held };
}

/** Claude's lock around ~/.claude.json, which a move writes the account's identity into. */
const stateLock = (c: PathCtx): string => `${defaultClaudeJsonPath(c)}.lock`;

/**
 * Point ~/.claude.json's account at `account`, so Claude shows the account it
 * runs on, under ccx's write-back lock (tried once). A file missing, empty or
 * not parsing is the user's to keep: nothing is written. Same account: the
 * file is left to the chats that also write it.
 */
function setStateAccount(account: unknown, c: PathCtx, undo: Undo): void {
  const file = defaultClaudeJsonPath(c);
  const was = asObject(readText(file));
  if (!account || !was || Object.keys(was).length === 0) return;
  const before = was.oauthAccount as { accountUuid?: unknown; organizationUuid?: unknown } | undefined;
  const now = account as { accountUuid?: unknown; organizationUuid?: unknown };
  if (before?.accountUuid && before.accountUuid === now.accountUuid && before.organizationUuid === now.organizationUuid) {
    return;
  }
  const written = mergeInto(file, c, (theirs) => ({ changed: true, theirs: { ...theirs, oauthAccount: account } }), 0);
  if (written === 'failed') throw new LockTaken(`${file} could not be written now`);
  undo.push(function* () {
    mergeInto(
      file,
      c,
      (theirs) => {
        if (!isDeepStrictEqual(theirs.oauthAccount, account)) return { changed: false, theirs };
        const back = { ...theirs };
        if (was.oauthAccount === undefined) delete back.oauthAccount;
        else back.oauthAccount = was.oauthAccount;
        return { changed: true, theirs: back };
      },
      0,
    );
  });
}

/** The default login's top-level organizationUuid follows the account it holds, as Claude writes it. */
function withOrganization(login: Record<string, unknown>, account: unknown): Record<string, unknown> {
  const org = (account as { organizationUuid?: unknown } | undefined)?.organizationUuid;
  const next = { ...login };
  if (typeof org === 'string') next.organizationUuid = org;
  else delete next.organizationUuid;
  return next;
}

/**
 * What goes home to a holder: its Claude login as the default login holds it
 * now, with what it kept aside. A login of its own made meanwhile (a sign-in
 * again) wins, and the MCP sign-ins it kept aside join that one.
 */
function homeText(own: string | null, login: unknown, kept: Record<string, unknown>): string | null {
  if (own !== null) {
    const parked = kept[MCP_OAUTH_KEY];
    return parked === undefined ? own : parkMcpLogins(own, JSON.stringify({ [MCP_OAUTH_KEY]: parked }));
  }
  if (login === undefined && Object.keys(kept).length === 0) return null;
  return JSON.stringify({ ...(login !== undefined ? { claudeAiOauth: login } : {}), ...kept });
}

/** A profile's saved login but its Claude login: what it keeps aside while the default login holds that. */
function asideOf(own: string): Record<string, unknown> {
  const rest = { ...(asObject(own) ?? {}) };
  delete rest.claudeAiOauth;
  return rest;
}

/** Hand the default login back to the profile holding it, and say what it holds now; the default keeps it until something replaces it. */
function* returnHomeSteps(
  holder: Account,
  current: string | null,
  c: PathCtx,
  io: KeychainIo,
  undo: Undo,
): Steps<string | null> {
  const markerFile = path.join(holder.dir, DEFAULT_LOGIN_MARKER);
  const markerText = readText(markerFile);
  const own = yield* readOwnSteps(holder.dir, c, io);
  const home = homeText(own, loginOf(current), keptAside(readDefaultLoginMarker(holder.dir)));
  if (home !== null && home !== own) {
    yield* writeOwnSteps(holder.dir, home, c, io);
    undo.push(function* () {
      if (own === null) yield* removeOwnSteps(holder.dir, c, io);
      else yield* writeOwnSteps(holder.dir, own, c, io);
    });
  }
  rmSync(markerFile, { force: true });
  undo.push(function* () {
    if (markerText !== null) writeSecretFile(markerFile, markerText);
  });
  return home ?? own;
}

/** Whether two Claude logins are one login: the same refresh token. */
function sameLogin(a: unknown, b: unknown): boolean {
  const token = (login: unknown): unknown => (login as { refreshToken?: unknown } | undefined)?.refreshToken;
  return typeof token(a) === 'string' && token(a) === token(b);
}

/** Keep the login Claude had before chat mode took over, once, so `ccx chat off` can put it back. */
function keepOriginal(current: string | null, c: PathCtx): void {
  const file = path.join(configHome(c), BACKUP);
  const login = loginOf(current);
  if (login === undefined || existsSync(file)) return;
  const state = asObject(readText(defaultClaudeJsonPath(c)));
  const org = asObject(current)?.organizationUuid;
  writeSecretFile(
    file,
    JSON.stringify({ claudeAiOauth: login, oauthAccount: state?.oauthAccount, ...(org !== undefined ? { organizationUuid: org } : {}) }),
  );
}

/** The default login with the one kept before chat mode put back, as it was. */
function restored(current: string | null, backup: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(asObject(current) ?? {}), claudeAiOauth: backup.claudeAiOauth };
  // A backup an older chat mode kept says nothing of it: the account's own organization stands in.
  if (!Object.hasOwn(backup, 'organizationUuid')) return withOrganization(next, backup.oauthAccount);
  next.organizationUuid = backup.organizationUuid;
  return next;
}

function* undoAll(undo: Undo): Steps<void> {
  for (const step of undo.reverse()) {
    try {
      yield* step();
    } catch {
      /* the step that failed is the one to report */
    }
  }
}

/**
 * Move `target`'s login into Claude's default login; the profile that held it
 * gets its own back. A holder signed in again on its own folder has that new
 * login moved in the same way. Nothing is changed while a lock it needs is
 * taken; a step that fails undoes the ones before it, and the error is thrown.
 */
export function* moveIntoDefaultLoginSteps(target: Account, c: PathCtx, io: KeychainIo): Steps<DefaultLoginMove> {
  if (!supported(c)) return { state: 'skipped', why: 'chat mode works on macOS and Linux' };
  const holder = holderOf(listAccounts(c));
  const holding = holder?.name === target.name;
  const previous = holding ? undefined : holder;
  const nothing = (): DefaultLoginMove =>
    holding
      ? { state: 'already', account: target.name }
      : { state: 'skipped', why: `"${target.name}" has no login of its own to move` };
  // Looked at before any lock: an account with nothing to move costs nothing.
  if (loginOf(yield* readOwnSteps(target.dir, c, io)) === undefined) return nothing();
  const locks = yield* takeLocks([
    defaultLoginLock(),
    stateLock(c),
    ...[target, ...(previous ? [previous] : [])].map((a) => path.join(a.dir, CREDENTIALS_LOCK_DIR)),
  ]);
  if (!locks.ok) return locks.busy ? { state: 'busy', why: locks.why } : { state: 'skipped', why: locks.why };
  const undo: Undo = [];
  try {
    // Read again under the locks: a renewal just before them may have changed either.
    const own = yield* readOwnSteps(target.dir, c, io);
    const login = loginOf(own);
    if (own === null || login === undefined) return nothing();
    const current = yield* call(() => io.read(DEFAULT_LOGIN));
    if (previous) yield* returnHomeSteps(previous, current, c, io, undo);
    else if (!holding) keepOriginal(current, c);
    const account = asObject(readText(path.join(target.dir, '.claude.json')))?.oauthAccount;
    const next = withOrganization({ ...(asObject(current) ?? {}), claudeAiOauth: login }, account);
    yield* call(() => io.write(DEFAULT_LOGIN, JSON.stringify(next)));
    undo.push(() => putBackDefault(current, io));
    setStateAccount(account, c, undo);
    try {
      writeSecretFile(previousCredentialPath(target.dir), own);
    } catch {
      /* the cushion is best effort */
    }
    // The rest of the profile's login (MCP sign-ins parked there) waits in its marker; the chats keep theirs.
    const markerFile = path.join(target.dir, DEFAULT_LOGIN_MARKER);
    const markerBefore = readText(markerFile);
    const kept = keptAside(readDefaultLoginMarker(target.dir));
    writeDefaultLoginMarker(target.dir, asideOf(holding ? (homeText(own, undefined, kept) ?? own) : own));
    undo.push(function* () {
      if (markerBefore !== null) writeSecretFile(markerFile, markerBefore);
      else rmSync(markerFile, { force: true });
    });
    yield* removeOwnSteps(target.dir, c, io);
    return { state: 'moved', account: target.name };
  } catch (error) {
    yield* undoAll(undo);
    if (error instanceof LockTaken) return { state: 'busy', why: error.message };
    throw error;
  } finally {
    for (const lock of locks.held) lock.release();
  }
}

/** moveIntoDefaultLoginSteps, blocking. */
export function moveIntoDefaultLogin(target: Account, c: PathCtx = {}): DefaultLoginMove {
  return runBlocking(moveIntoDefaultLoginSteps(target, c, keychainBlocking));
}

function* followSteps(c: PathCtx, io: KeychainIo): Steps<DefaultLoginMove> {
  const active = getActive(c);
  const account = active ? getAccount(active, c) : undefined;
  if (!account) return { state: 'skipped', why: 'there is no active account' };
  return yield* moveIntoDefaultLoginSteps(account, c, io);
}

/**
 * Bring the active account's login into the default login when chat mode is
 * on: after a switch, and as chat mode is turned on. On timers, its Keychain
 * work off the thread, so a running session can call it. While a lock is
 * taken it looks again every LOOK_MS for RETRY_MS, then leaves the move to the
 * next switch. Never throws.
 */
export async function followActiveInDefaultLogin(
  c: PathCtx = {},
  options: { retryMs?: number; lookMs?: number } = {},
): Promise<DefaultLoginFollow> {
  if (!defaultLoginEnabled(c)) return { state: 'skipped', why: 'chat mode is off' };
  const giveUpAt = Date.now() + (options.retryMs ?? RETRY_MS);
  for (;;) {
    let outcome: DefaultLoginMove;
    try {
      outcome = await runOnTimers(followSteps(c, keychainOnTimers));
    } catch (error) {
      return { state: 'failed', why: thrownReason(error) };
    }
    if (outcome.state !== 'busy' || Date.now() >= giveUpAt) return outcome;
    await new Promise((resolve) => setTimeout(resolve, options.lookMs ?? LOOK_MS));
  }
}

type TurnOff = { state: 'done'; signedOut?: true } | { state: 'busy' | 'skipped'; why: string };

/**
 * Give the default login back to its holder, and put back the login Claude had
 * before chat mode. With none kept, Claude had no login of its own then, and
 * none stays: a copy of the account's left there, which ccx no longer carries
 * renewals into, would end at the account's next renewal anyway.
 */
function* turnOffSteps(c: PathCtx, io: KeychainIo): Steps<TurnOff> {
  const holder = holderOf(listAccounts(c));
  const backupFile = path.join(configHome(c), BACKUP);
  const backup = asObject(readText(backupFile)) ?? {};
  if (!holder && backup.claudeAiOauth === undefined) return { state: 'done' };
  const locks = yield* takeLocks([
    defaultLoginLock(),
    stateLock(c),
    ...(holder ? [path.join(holder.dir, CREDENTIALS_LOCK_DIR)] : []),
  ]);
  if (!locks.ok) return { state: locks.busy ? 'busy' : 'skipped', why: locks.why };
  const undo: Undo = [];
  try {
    const current = yield* call(() => io.read(DEFAULT_LOGIN));
    const home = holder ? yield* returnHomeSteps(holder, current, c, io, undo) : null;
    if (backup.claudeAiOauth !== undefined) {
      const next = restored(current, backup);
      yield* call(() => io.write(DEFAULT_LOGIN, JSON.stringify(next)));
      undo.push(() => putBackDefault(current, io));
      setStateAccount(backup.oauthAccount, c, undo);
      rmSync(backupFile, { force: true });
    } else if (sameLogin(loginOf(current), loginOf(home))) {
      const next = { ...(asObject(current) ?? {}) };
      delete next.claudeAiOauth;
      delete next.organizationUuid;
      yield* call(() => io.write(DEFAULT_LOGIN, JSON.stringify(next)));
      undo.push(() => putBackDefault(current, io));
      return { state: 'done', signedOut: true };
    }
    return { state: 'done' };
  } catch (error) {
    yield* undoAll(undo);
    if (error instanceof LockTaken) return { state: 'busy', why: error.message };
    throw error;
  } finally {
    for (const lock of locks.held) lock.release();
  }
}

/** `ccx chat on|off`: chats on Claude's own default login (plain ~/.claude) switch along with ccx. */
export async function setDefaultLoginMode(
  on: boolean,
  c: PathCtx = {},
  options: { retryMs?: number; lookMs?: number } = {},
): Promise<string> {
  const flag = path.join(configHome(c), FLAG);
  if (on) {
    if (!supported(c)) return 'chat mode works on macOS and Linux only';
    writeSecretFile(flag, '');
    const moved = await followActiveInDefaultLogin(c, options);
    switch (moved.state) {
      case 'moved':
      case 'already':
        return `chat mode on: chats on your normal Claude login now use "${moved.account}" and follow every switch`;
      case 'busy':
        return `chat mode on: Claude is busy with its login (${moved.why}), so the active account moves in at the next switch`;
      case 'skipped':
        return `chat mode on: nothing moved in yet (${moved.why})`;
      case 'failed':
        return `chat mode on, but the active account could not be moved in: ${moved.why}`;
    }
  }
  rmSync(flag, { force: true });
  const giveUpAt = Date.now() + (options.retryMs ?? RETRY_MS);
  for (;;) {
    let off: TurnOff;
    try {
      off = await runOnTimers(turnOffSteps(c, keychainOnTimers));
    } catch (error) {
      return `chat mode off, but your normal Claude login could not be put back: ${thrownReason(error)}; run \`ccx chat off\` again`;
    }
    if (off.state === 'done') {
      return off.signedOut
        ? 'chat mode off: Claude had no login of its own before chat mode, so its chats are signed out again'
        : 'chat mode off: your normal Claude login is back as it was';
    }
    if (off.state === 'skipped' || Date.now() >= giveUpAt) {
      return `chat mode off, but your normal Claude login is not back yet (${off.why}); run \`ccx chat off\` again`;
    }
    await new Promise((resolve) => setTimeout(resolve, options.lookMs ?? LOOK_MS));
  }
}
