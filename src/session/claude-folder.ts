import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CREDENTIALS_FILE,
  credentialPath,
  installCredentialSteps,
  nudgeLoginRereadSteps,
} from '../accounts/credential-vault.js';
import {
  readCredentialSteps,
  removeCredentialSteps,
  writeCredentialSteps,
} from '../accounts/credential-storage.js';
import { holdsNoLogin, mergeMcpLogins } from '../accounts/mcp-logins.js';
import type { KeychainIo } from '../accounts/keychain-view.js';
import { CREDENTIALS_LOCK_DIR, lockDirHeld, lockDirSteps } from '../claude/locks.js';
import { runBlocking, type Steps } from '../util/steps.js';
import { readReferenceConfig, onboardingFlags } from '../daemon/reference-config.js';
import { secureMkdir, writeSecretFile } from '../util/secret-file.js';
import { retireKeptSettings } from './session-dir.js';
import {
  copyUserSettings,
  ensureSharedProjects,
  ensureSharedUserConfig,
  linkSharedDirs,
  syncSharedFiles,
} from './shared-root.js';
import {
  forgetEarlierStart,
  snapshotSettingsBase,
  snapshotStateBase,
  syncSettings,
  syncState,
  writeUserFile,
  type FolderSync,
  type SettingsPassage,
} from './write-back.js';
import type { PathCtx } from '../config/paths.js';

/**
 * The one kind of folder ccx runs Claude in: a config folder of its own, so its
 * login can be replaced under a running Claude, with everything else of the
 * user's ~/.claude linked in (projects and the rest), the user's real settings,
 * and Claude's state built from the user's own. A terminal session and a worker
 * each have one for as long as they run (`sessions/<pid>`); the editor has one
 * that never ends (`editor-active`), refreshed at ccx's events.
 */

/** Make `dir` a Claude folder of ccx's, as it is for a session starting in it. */
export function buildClaudeFolder(dir: string, c: PathCtx = {}): void {
  secureMkdir(dir);
  // What an earlier Claude here started from, if its folder could not be
  // cleared, is not this one's start.
  forgetEarlierStart(dir);
  // Share the user's REAL ~/.claude session/memory store (projects) so /resume
  // and project memories are complete and identical in ccx sessions and plain
  // `claude` alike. Self-heals each start; skips safely if files are busy.
  ensureSharedProjects(dir, c);
  // And everything else of ~/.claude but the login: prompt history, /rewind
  // checkpoints, plugins, the editor link, skills (ccx's own `/ccx` among
  // them), agents, commands, memory, keybindings. See ensureSharedUserConfig.
  ensureSharedUserConfig(dir, c);
  // The user's real settings, exactly: a ccx session is their own Claude but
  // for the account. Nothing is laid over them any more, neither an account
  // folder's settings nor ccx's old store of session settings, which is folded
  // into the real file once and retired.
  retireKeptSettings(c);
  copyUserSettings(dir, c);
  // What the folder starts with, so what it changes can be handed back.
  snapshotSettingsBase(dir);
}

/** How the folders of a long-lived Claude folder came out of a refresh. */
export interface FolderRefresh {
  settings: FolderSync;
  state: FolderSync;
  /** Whether every one of the user's files linked in is in step. */
  files: boolean;
}

/**
 * Bring a folder that never ends into step with the user's ~/.claude: what is
 * new there linked in, and its settings, Claude's state and the user's files
 * synced both ways. The caller keeps two refreshes of one folder apart.
 * `lockWaitMs`, when given, is how long each lock it takes may be waited for;
 * one not had then leaves that part to the next refresh.
 */
export function refreshClaudeFolder(
  dir: string,
  c: PathCtx = {},
  passage: SettingsPassage = {},
  lockWaitMs?: number,
): FolderRefresh {
  ensureSharedProjects(dir, c);
  linkSharedDirs(dir, c);
  return {
    settings: syncSettings(dir, c, passage, lockWaitMs),
    state: syncState(dir, c, lockWaitMs),
    files: syncSharedFiles(dir, c, (file, plan) => writeUserFile(file, c, plan, lockWaitMs)),
  };
}

function readJsonSafe(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const IDENTITY_KEYS = ['oauthAccount', 'userID'] as const;

/** The account-identity fields that must follow the active account across swaps. */
export function identityFields(accountDir: string): Record<string, unknown> {
  const account = readJsonSafe(path.join(accountDir, '.claude.json')) ?? {};
  const id: Record<string, unknown> = {};
  for (const key of IDENTITY_KEYS) {
    if (key in account) id[key] = account[key];
  }
  return id;
}

/**
 * Put the identity fields of a folder's .claude.json back to `before`, what
 * identityFields read from the folder ahead of a move that failed. Only those
 * fields: Claude may have written the rest of the file meanwhile.
 */
export function restoreFolderIdentity(dir: string, before: Record<string, unknown>): void {
  const file = path.join(dir, '.claude.json');
  const now = readJsonSafe(file);
  if (!now) return;
  const next = { ...now };
  for (const key of IDENTITY_KEYS) {
    if (key in before) next[key] = before[key];
    else delete next[key];
  }
  writeJsonSafe(file, next);
}

/**
 * Build/refresh the folder's .claude.json so the interactive app treats it as
 * fully onboarded and logged in as the active account.
 * - First build: inherit the user's onboarding flags (from their default config)
 *   so login/theme/trust prompts are skipped, mark the cwd trusted, and stamp the
 *   account identity.
 * - Later swaps: only re-stamp the identity, PRESERVING everything the user has
 *   answered in this folder (so prompts do not reappear).
 * Throws when the file cannot be written, so a move rolls back rather than
 * leave the new login beside the last account's identity.
 */
export function applyAccountIdentity(dir: string, accountDir: string, ctx: PathCtx): void {
  const sessionPath = path.join(dir, '.claude.json');
  const existing = readJsonSafe(sessionPath);
  const identity = identityFields(accountDir);
  const next =
    existing && existing.hasCompletedOnboarding
      ? { ...existing, ...identity }
      : firstBuild(identity, ctx);
  // An account with no identity of its own takes on none: not the last
  // account's in the folder, nor the default account's in the user's config.
  for (const key of IDENTITY_KEYS) {
    if (!(key in identity)) delete next[key];
  }
  writeSecretFile(sessionPath, JSON.stringify(next));
}

function firstBuild(identity: Record<string, unknown>, ctx: PathCtx): Record<string, unknown> {
  // First build: inherit the user's FULL working config (onboarding done, theme,
  // trusted folders, MCP servers, all preferences), then overlay this account's
  // identity and mark the current folder trusted. This reproduces their normal
  // environment exactly, minus the account, so no first-run prompts appear.
  const reference = readReferenceConfig(ctx);
  const base = Object.keys(reference).length > 0 ? { ...reference } : onboardingFlags({});
  const cwd = process.cwd();
  const projects: Record<string, unknown> =
    typeof base.projects === 'object' && base.projects
      ? { ...(base.projects as Record<string, unknown>) }
      : {};
  projects[cwd] = {
    ...(projects[cwd] as Record<string, unknown>),
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };

  return {
    ...base,
    hasCompletedOnboarding: true,
    ...identity,
    projects,
  };
}

/** Write the folder's config owner-only, as best it can: it carries the account's identity. */
function writeJsonSafe(file: string, data: unknown): void {
  try {
    writeSecretFile(file, JSON.stringify(data));
  } catch {
    /* best effort */
  }
}

/** Where a folder keeps its login, and how a move changes it, each as steps (util/steps). */
export interface FolderLoginStore {
  /** Put the login in `sourceFile` here. False, changing nothing, when it holds no usable login. */
  install(sourceFile: string): Steps<boolean>;
  /** Leave no login here. */
  scrub(): Steps<void>;
  /** Put back the login a failed move replaced. */
  rollback(): Steps<void>;
  /** Make a Claude running here read its login again at its next request (nudgeLoginReread). */
  nudge(now: Date): Steps<boolean>;
}

/**
 * A session folder's login: its file, or the Keychain item Claude may have
 * moved it to, reached through `io`: blocking, or on timers while its Claude runs.
 * The folder keeps its own MCP logins through a move, and a rollback puts back
 * the login the move found there, not a copy kept from an earlier one.
 */
export function sessionLoginStore(
  dir: string,
  io: KeychainIo,
  keychainHolds?: (dir: string) => boolean,
): FolderLoginStore {
  const file = credentialPath(dir);
  let before: string | null = null;
  let remembered = false;
  let changed = false;
  return {
    install: (sourceFile) =>
      installCredentialSteps(dir, sourceFile, io, {
        mcp: 'folder',
        replaced: (previous) => {
          if (!remembered) before = previous;
          remembered = true;
          // A write the Keychain reports failed may have gone in.
          changed = true;
        },
      }),
    *scrub() {
      if (!remembered) {
        try {
          before = yield* readCredentialSteps(file, io);
        } catch (error) {
          if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
        }
        remembered = true;
      }
      try {
        yield* removeCredentialSteps(file, io);
      } finally {
        changed = true;
      }
    },
    *rollback() {
      if (!changed) return;
      const held = before;
      if (held === null) {
        yield* removeCredentialSteps(file, io);
        return;
      }
      // What its Claude saved since the move, an MCP sign-in it refreshed, is kept over the one it replaced.
      yield* writeCredentialSteps(
        file,
        holdsNoLogin(held) ? held : (current) => mergeMcpLogins(held, current, 'folder'),
        io,
      );
    },
    nudge: (now) => nudgeLoginRereadSteps(dir, now, io, keychainHolds ? { keychainHolds } : {}),
  };
}

export interface FolderLoginMove {
  /** Run under the lock before anything is replaced: the login being left goes home here. */
  leaving?: () => Steps<void>;
  /** Run once the new login and identity are in, before Claude is told to read it. */
  installed?: () => Steps<void>;
  /** Undo the move when the running Claude cannot be made sure to read the new login. */
  mustReread?: boolean;
  /**
   * Only while holding both locks a Claude here takes, its login's and its
   * state's (`.claude.json.lock`), each tried once: nothing is written, and
   * false is returned, when either is taken. Every move under a running Claude
   * passes it. Without it, as at a session's start before its Claude runs, the
   * move waits a little for the login's lock, then goes ahead: a lock there
   * then is one a Claude that has ended left behind.
   */
  onlyUnderClaudesLocks?: boolean;
}

/** The lock Claude 2.1.302 takes to save `<folder>/.claude.json`, under which it reads the file again first. */
const stateLockOf = (dir: string): string => `${path.join(dir, '.claude.json')}.lock`;

/**
 * Whether a Claude in `dir` looks to hold either lock a move needs, by looking
 * only. The move tries the locks themselves all the same: this answer can be
 * out of date by the time it is acted on.
 */
export function claudesLocksTaken(dir: string): boolean {
  return lockDirHeld(path.join(dir, CREDENTIALS_LOCK_DIR)) || lockDirHeld(stateLockOf(dir));
}

/**
 * Move a folder's login to the account in `accountDir`, under Claude's own
 * credential lock, so it cannot collide with a renewal by a Claude running
 * there, and roll the folder back when any step fails, rather than leave it on
 * a half-applied account. False when it did not move (onlyUnderClaudesLocks).
 * Blocking: for a folder whose Claude's terminal is not relayed on this thread.
 */
export function moveFolderLogin(
  dir: string,
  accountDir: string,
  ctx: PathCtx,
  store: FolderLoginStore,
  move: FolderLoginMove = {},
): boolean {
  return runBlocking(moveFolderLoginSteps(dir, accountDir, ctx, store, move));
}

/**
 * moveFolderLogin as steps, for a session to run on timers while its Claude
 * runs. Both locks are tried at once, before the first step that waits, and
 * held until the move has finished or been rolled back; while they are held
 * their times are kept fresh (claude/locks), so Claude never takes either
 * for one left behind.
 */
export function* moveFolderLoginSteps(
  dir: string,
  accountDir: string,
  ctx: PathCtx,
  store: FolderLoginStore,
  move: FolderLoginMove = {},
): Steps<boolean> {
  if (!move.onlyUnderClaudesLocks) {
    const lock = yield* lockDirSteps(path.join(dir, CREDENTIALS_LOCK_DIR));
    try {
      yield* applyFolderLoginMove(dir, accountDir, ctx, store, move);
    } finally {
      lock.release();
    }
    return true;
  }
  const login = yield* lockDirSteps(path.join(dir, CREDENTIALS_LOCK_DIR), { waitMs: 0 });
  if (!login.held) return false;
  try {
    const state = yield* lockDirSteps(stateLockOf(dir), { waitMs: 0 });
    if (!state.held) return false;
    try {
      yield* applyFolderLoginMove(dir, accountDir, ctx, store, move);
      return true;
    } finally {
      state.release();
    }
  } finally {
    login.release();
  }
}

function* applyFolderLoginMove(
  dir: string,
  accountDir: string,
  ctx: PathCtx,
  store: FolderLoginStore,
  move: FolderLoginMove,
): Steps<void> {
  if (move.leaving) yield* move.leaving();
  const src = path.join(accountDir, CREDENTIALS_FILE);
  // Who the folder says it is signed in as, put back with the login if this fails.
  const identityBefore = identityFields(dir);
  // Always replace (or clear) the folder's credential so one account's login
  // can never linger into another account's run.
  try {
    // A refused credential (missing, or signed out with empty tokens) must
    // CLEAR the folder, never leave the previous account's login in place:
    // Claude would keep running as that account while ccx believed it had
    // moved, and its limit would then be blamed on the wrong account.
    if (!(yield* store.install(src))) {
      yield* store.scrub();
    }
    // Stamp the account's identity (oauthAccount/userID) so the interactive
    // app sees a logged-in account instead of prompting for login.
    applyAccountIdentity(dir, accountDir, ctx);
    // Once, as first built: later swaps only change the identity in it.
    snapshotStateBase(dir);
    if (move.installed) yield* move.installed();
    // A Claude already running here keeps the login it read until the
    // file's time changes, which a Keychain write does not do. A move
    // away for one call is undone when that cannot be made sure of,
    // since the call goes out at once. Any other move stands: Claude
    // reads the new login within 30 seconds regardless.
    if (!(yield* store.nudge(new Date())) && move.mustReread) {
      throw new Error('the time of its login file could not be changed');
    }
  } catch (e) {
    restoreFolderIdentity(dir, identityBefore);
    yield* store.rollback();
    throw e;
  }
}
