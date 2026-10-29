import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  credentialPath,
  isUsableCredential,
  installCredentialSteps,
  loginTextFingerprint,
  sessionIdentityEmail,
  usableLoginText,
} from './credential-vault.js';
import { loginExpiresAt } from '../usage/token-expiry.js';
import { CREDENTIALS_LOCK_DIR, lockDirSteps } from '../claude/locks.js';
import { copyCredentialSteps, readCredentialSteps } from './credential-storage.js';
import { keychainBlocking, keychainOnTimers, type KeychainIo } from './keychain-view.js';
import { runBlocking, runOnTimers, type Steps } from '../util/steps.js';
import { logCredentialEvent } from '../accounts/credential-log.js';
import { liveLeases } from '../session/lease.js';
import type { PathCtx } from '../config/paths.js';

/**
 * One login per account, however many copies exist.
 *
 * A refresh token is single-use: renewing rotates it, and every other copy of
 * the old one is dead from that moment. With one directory per session, an
 * account's login exists in several places at once (the profile, plus every
 * live session running that account), and each copy renews on its own clock.
 * Whoever renewed first killed the rest: the operator's sessions took turns
 * hitting "please run /login", and the profile itself was often the stalest
 * copy, so every NEW session started on a corpse. Found live: three copies of
 * one lineage across two sessions and the profile, a fourth session holding an
 * already-retired lineage, and four dead lineages in the refusal log.
 *
 * The model this file enforces: the PROFILE is the hub. A session that renews
 * pushes its login home (the mirror in session.ts, which asks the API who the
 * login belongs to before writing). This file adds the missing direction:
 *
 * - PULL: when the hub holds a NEWER lineage than a running session, the
 *   session's copy is replaced before its Claude tries to refresh the retired
 *   one. Claude re-reads the file under its own lock before refreshing (that is
 *   how several plain `claude` terminals survive sharing one file), so a copy
 *   swapped in between refreshes is picked up cleanly.
 * - RECOVER: when the hub's login is dead but a live session of the SAME
 *   account holds a working one, adopt it instead of telling the operator to
 *   sign in. The session's copy was renewed by its Claude; the hub just never
 *   heard.
 *
 * Identity is the hard rule in both directions: nothing is copied between a
 * session and a profile unless they are the same registered account. A session
 * that became somebody else via /login keeps its own login untouched; rotation
 * realigns it, not sync.
 */

export interface SyncAccount {
  name: string;
  dir: string;
  /** The address recorded at registration; the identity rule needs it. */
  email?: string;
}

export type PullDecision =
  | { pull: true; reason: string }
  | { pull: false; reason: string };

export interface PullEvidence {
  /** Is the session's copy a usable login at all? */
  sessionUsable: boolean;
  /** Is the profile's? */
  profileUsable: boolean;
  /** Same refresh-token lineage on both sides? */
  sameLineage: boolean;
  /** Who the session is signed in as, when recorded. */
  sessionEmail: string | null;
  /** The account's registered address, when recorded. */
  accountEmail: string | null;
  /** When each side's access token expires; 0 when unknown. */
  sessionExpiresAt: number;
  profileExpiresAt: number;
}

/**
 * Should the profile's login replace the session's copy?
 *
 * Pure, so every branch is testable. The expensive mistakes each get a rule:
 * overwriting a live session that became a different account would hijack a
 * running Claude (identity rule); overwriting a session whose copy is NEWER
 * would un-renew it (freshness rule); doing nothing when the session's lineage
 * is retired is the /login bug this file exists to end.
 */
export function decidePull(e: PullEvidence): PullDecision {
  if (!e.profileUsable) return { pull: false, reason: 'the profile has no usable login to give' };
  if (e.sameLineage) return { pull: false, reason: 'both copies are the same login already' };
  if (e.sessionUsable && e.sessionEmail && e.accountEmail) {
    if (e.sessionEmail.trim().toLowerCase() !== e.accountEmail.trim().toLowerCase()) {
      return {
        pull: false,
        reason: 'the session is signed in as a different account; its login is not ours to replace',
      };
    }
  }
  if (!e.sessionUsable) {
    return { pull: true, reason: 'the session has no working login; the profile does' };
  }
  if (e.profileExpiresAt > e.sessionExpiresAt) {
    return {
      pull: true,
      reason: 'the stored login was renewed elsewhere; the session copy is a retired lineage',
    };
  }
  return {
    pull: false,
    reason: 'the session copy is at least as fresh; the mirror carries it home, not the reverse',
  };
}

export type PullResult = 'pulled' | 'skipped' | 'busy';

type SnapshotOutcome<T> = { ok: true; value: T } | { ok: false; reason: 'busy' | 'unreadable' };

/**
 * Copy the source login under ITS OWN credential lock, then hand back a private
 * snapshot to work from.
 *
 * installCredential validates its source and then reads it again, and between
 * those reads a live refresh can replace the file. Claude's writes are not
 * guaranteed atomic (a killed refresh leaves a partial file, which is why
 * isUsableCredential exists at all), so the copy is taken while nothing can be
 * writing, and everything after that operates on the immutable snapshot.
 * Try-only: a busy source lock means a refresh is mid-write, which is exactly
 * when to come back later rather than wait.
 */
function* sourceSnapshotSteps<T>(
  sourceDir: string,
  use: (snapshot: string) => Steps<T>,
  io: KeychainIo,
): Steps<SnapshotOutcome<T>> {
  const lock = yield* lockDirSteps(path.join(sourceDir, CREDENTIALS_LOCK_DIR), { waitMs: 0 });
  if (!lock.held) return { ok: false, reason: 'busy' };
  const snapshot = `${credentialPath(sourceDir)}.snapshot.${process.pid}`;
  try {
    yield* copyCredentialSteps(credentialPath(sourceDir), snapshot, io);
  } catch {
    lock.release();
    return { ok: false, reason: 'unreadable' };
  }
  lock.release();
  try {
    return { ok: true, value: yield* use(snapshot) };
  } finally {
    try {
      rmSync(snapshot, { force: true });
    } catch {
      /* a leftover snapshot is owner-only and replaced next time */
    }
  }
}

/**
 * Carry a renewal that happened elsewhere INTO this running session.
 *
 * Runs under the same lock Claude uses to coordinate its refreshes, and only
 * when that lock is free: a busy lock means a refresh is mid-write, which is
 * exactly when to come back on the next tick instead.
 */
export function pullProfileIntoSession(
  account: SyncAccount,
  sessionDir: string,
  ctx: PathCtx = {},
): PullResult {
  // Cheap pre-check outside the lock: same lineage is the overwhelmingly
  // common case and needs no lock to detect. Re-checked inside.
  if (readPullEvidence(account, sessionDir).sameLineage) return 'skipped';
  return runBlocking(pullSteps(account, sessionDir, ctx, keychainBlocking));
}

/**
 * pullProfileIntoSession for a running session: the pre-check reads the
 * Keychain as the session last read it, and what is done under the lock reads
 * and writes it on timers.
 */
export async function pullProfileIntoSessionAsync(
  account: SyncAccount,
  sessionDir: string,
  ctx: PathCtx = {},
): Promise<PullResult> {
  if (readPullEvidence(account, sessionDir).sameLineage) return 'skipped';
  return runOnTimers(pullSteps(account, sessionDir, ctx, keychainOnTimers));
}

function* pullSteps(account: SyncAccount, sessionDir: string, ctx: PathCtx, io: KeychainIo): Steps<PullResult> {
  const lock = yield* lockDirSteps(path.join(sessionDir, CREDENTIALS_LOCK_DIR), { waitMs: 0 });
  if (!lock.held) return 'busy';
  try {
    const evidence = yield* readPullEvidenceSteps(account, sessionDir, io);
    const decision = decidePull(evidence);
    if (!decision.pull) return 'skipped';
    // From a snapshot taken under the PROFILE's own lock, so a refresh that is
    // mid-write when we look can never be half-copied into a running session.
    const installed = yield* sourceSnapshotSteps(
      account.dir,
      (snapshot) => installCredentialSteps(sessionDir, snapshot, io, { mcp: 'folder' }),
      io,
    );
    if (!installed.ok) return installed.reason === 'busy' ? 'busy' : 'skipped';
    if (!installed.value) return 'skipped';
    logCredentialEvent(
      {
        account: account.name,
        kind: 'installed',
        detail:
          'the stored login was renewed elsewhere; carried into this running session ' +
          'so its next refresh cannot die on the retired one',
      },
      ctx,
    );
    return 'pulled';
  } finally {
    lock.release();
  }
}

function readPullEvidence(account: SyncAccount, sessionDir: string): PullEvidence {
  return runBlocking(readPullEvidenceSteps(account, sessionDir, keychainBlocking));
}

/** Each side's login read once, and judged as credentialFingerprint, isUsableCredential and readExpiresAt would. */
function* readPullEvidenceSteps(account: SyncAccount, sessionDir: string, io: KeychainIo): Steps<PullEvidence> {
  const session = yield* loginOrNull(credentialPath(sessionDir), io);
  const profile = yield* loginOrNull(credentialPath(account.dir), io);
  const sessionPrint = session === null ? null : loginTextFingerprint(session);
  const profilePrint = profile === null ? null : loginTextFingerprint(profile);
  return {
    sessionUsable: session !== null && usableLoginText(session),
    profileUsable: profile !== null && usableLoginText(profile),
    sameLineage: sessionPrint !== null && sessionPrint === profilePrint,
    sessionEmail: sessionIdentityEmail(sessionDir),
    accountEmail: account.email ?? null,
    sessionExpiresAt: session === null ? 0 : loginExpiresAt(session),
    profileExpiresAt: profile === null ? 0 : loginExpiresAt(profile),
  };
}

function* loginOrNull(file: string, io: KeychainIo): Steps<string | null> {
  try {
    return yield* readCredentialSteps(file, io);
  } catch {
    return null;
  }
}

export interface RecoverResult {
  recovered: boolean;
  /** Which session's login was adopted, for the log. */
  fromPid?: number;
}

/**
 * A profile whose login is dead, while a live session of the same account runs
 * on a working one: adopt the session's copy instead of demanding a sign-in.
 *
 * Only on positive identity: the lease says which account the session is FOR,
 * but leases have lied before (a contaminated session carried another account's
 * login under the right lease), so the session's own recorded identity must
 * match the account's registered address. No address, no adoption.
 */
export function recoverLoginFromLiveSession(
  account: SyncAccount,
  ownSessionDir: string | null,
  ctx: PathCtx = {},
): RecoverResult {
  if (!account.email) return { recovered: false };
  const wanted = account.email.trim().toLowerCase();
  for (const lease of liveLeases(ctx)) {
    if (lease.account !== account.name) continue;
    if (!lease.configDir || !existsSync(lease.configDir)) continue;
    if (ownSessionDir && path.resolve(lease.configDir) === path.resolve(ownSessionDir)) continue;
    if (!isUsableCredential(credentialPath(lease.configDir))) continue;
    const identity = sessionIdentityEmail(lease.configDir);
    if (!identity || identity.trim().toLowerCase() !== wanted) continue;
    // Snapshot under the SESSION's own lock: its Claude can be mid-refresh at
    // this exact moment, and adopting half a write would destroy the profile
    // login this is trying to save.
    const adopted = runBlocking(
      sourceSnapshotSteps(
        lease.configDir,
        (snapshot) => installCredentialSteps(account.dir, snapshot, keychainBlocking),
        keychainBlocking,
      ),
    );
    if (!adopted.ok || !adopted.value) continue;
    logCredentialEvent(
      {
        account: account.name,
        kind: 'installed',
        detail:
          `the stored login was dead, but the live session (pid ${lease.pid}) holds a working ` +
          'one for this account; adopted it instead of asking for a sign-in',
      },
      ctx,
    );
    return { recovered: true, fromPid: lease.pid };
  }
  return { recovered: false };
}
