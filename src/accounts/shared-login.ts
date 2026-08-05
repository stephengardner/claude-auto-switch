import { installCredential, credentialFingerprint, credentialPath } from './credential-vault.js';
import { withCredentialLock } from '../claude/locks.js';
import { copySecretFile } from '../util/secret-file.js';
import { rmSync } from 'node:fs';

/**
 * Keeping profiles that share ONE login from killing each other.
 *
 * Two profiles can hold the same Anthropic login: the browser stays signed in
 * between `ccx login` runs, so signing in twice quietly produces a duplicate.
 * Renewing rotates the refresh token and retires the previous one immediately,
 * so the moment either profile renews, the other is holding a dead token and
 * the next thing to touch it gets `invalid_grant`.
 *
 * That is not theoretical: it is how an account here died. The usage refresh
 * already refuses to renew a shared login for this reason, but a session
 * STARTING on one renewed it with no such check, and the sibling was finished
 * from that moment.
 *
 * Refusing at session start would be the wrong answer, because the session
 * needs a working token to run at all. The right one is to carry the renewal
 * across: the profiles are the same account, so they should hold the same
 * login.
 */

export interface SharedProfile {
  name: string;
  dir: string;
}

export interface SharingSnapshot {
  /** Profiles holding the same login right now. */
  sharedWith: SharedProfile[];
  /** The identity of the login they share, before anything rotates it. */
  fingerprint: string | null;
}

/**
 * Who shares this login, captured BEFORE a renewal.
 *
 * The order is the whole point and is easy to get backwards: renewing rotates
 * the token, so asking afterwards finds nobody sharing anything and the
 * siblings are silently left holding a dead login. Taking the snapshot is a
 * separate step so that ordering can be tested rather than assumed.
 */
export function snapshotSharing(
  account: SharedProfile,
  accounts: SharedProfile[],
  sharedNames: string[],
): SharingSnapshot {
  return {
    sharedWith: accounts.filter((a) => a.name !== account.name && sharedNames.includes(a.name)),
    fingerprint: credentialFingerprint(account.dir),
  };
}

/**
 * Replace a profile's login and carry it to the profiles that shared the old
 * one, in one call.
 *
 * The order is the correctness property and it cannot be observed afterwards:
 * the snapshot has to be taken BEFORE the write, because writing destroys the
 * shared value that identifies who was sharing it. Doing it as three statements
 * at the call site means a later edit can reorder them and nothing fails, which
 * was true of exactly these three statements until this existed. Here the order
 * is inside one function, so it is testable and cannot drift.
 *
 * `write` may throw: the caller decides what a failed write means, and nothing
 * is carried when there was no successful write to carry.
 */
export function writeAndCarry(
  target: SharedProfile,
  allProfiles: SharedProfile[],
  sharedNames: string[],
  write: () => void,
  deps: PropagateDeps = {},
): string[] {
  const sharing = snapshotSharing(target, allProfiles, sharedNames);
  write();
  return propagateRenewal(
    {
      renewedDir: target.dir,
      siblings: sharing.sharedWith,
      retired: sharing.fingerprint,
      renewed: credentialFingerprint(target.dir),
    },
    deps,
  );
}

export interface PropagateInput {
  /** The profile that was just renewed, whose login is being carried across. */
  renewedDir: string;
  siblings: SharedProfile[];
  /** What the shared login was BEFORE the renewal. */
  retired: string | null;
  /**
   * What the renewal produced. Propagation is bound to this exact credential, so
   * a login replaced again after the renewal (a sign-in, another refresh) is
   * never copied anywhere: the source is re-checked rather than assumed.
   */
  renewed: string | null;
}

export interface PropagateDeps {
  /** Injectable so a write failure can be FORCED in a test rather than hoped for. */
  install?: (destDir: string, sourceFile: string) => boolean;
  /** Injectable so an interleaving between the check and the write can be staged. */
  lock?: (dir: string, fn: () => void) => void;
}

/**
 * Copy a freshly renewed login into the profiles that were sharing the one it
 * replaced. Returns the names actually updated.
 *
 * Two things make this safe to do automatically:
 *
 * - a profile is written only while it still holds EXACTLY the credential that
 *   was just retired, re-checked inside that profile's own credential lock. The
 *   check and the write are otherwise separate moments, and a sign-in landing
 *   between them would be overwritten by an older login.
 * - the SOURCE is verified once, against the credential the renewal actually
 *   produced, and then COPIED. Siblings are written from that copy, so what was
 *   verified is exactly what lands: passing the source path instead would let a
 *   sign-in in the gap be installed without ever having been checked.
 *
 * Guessing about someone's login is what scrambled these profiles once before,
 * so both conditions are exact rather than approximate.
 */
export function propagateRenewal(input: PropagateInput, deps: PropagateDeps = {}): string[] {
  const { renewedDir, siblings, retired, renewed } = input;
  const install = deps.install ?? installCredential;
  const lock = deps.lock ?? ((dir, fn) => withCredentialLock(dir, fn));

  // Nothing to match on, or the source is no longer the login this was asked to
  // carry. Either way there is no safe copy to make.
  if (!retired || !renewed) return [];
  if (credentialFingerprint(renewedDir) !== renewed) return [];

  // Copy the verified source ONCE, and hand siblings that copy.
  //
  // Verifying the source and then passing its PATH to the installer leaves the
  // file mutable between the two: the installer reads it again, so a sign-in in
  // that gap would be copied into a sibling without ever having been checked.
  // A snapshot cannot change under anyone, so what is verified is exactly what
  // is written. Taken inside the source's own lock, and kept in the profile
  // directory (already owner-only) rather than a shared temp area.
  const snapshot = `${credentialPath(renewedDir)}.propagate.${process.pid}.tmp`;
  let ready = false;
  try {
    lock(renewedDir, () => {
      if (credentialFingerprint(renewedDir) !== renewed) return;
      copySecretFile(credentialPath(renewedDir), snapshot);
      ready = true;
    });
  } catch {
    return [];
  }
  if (!ready) return [];

  const updated: string[] = [];
  try {
    for (const sibling of siblings) {
      if (sibling.dir === renewedDir) continue;
      // Cheap check first, so the ordinary "nothing to do" case takes no lock.
      if (credentialFingerprint(sibling.dir) !== retired) continue;
      try {
        lock(sibling.dir, () => {
          // Re-checked INSIDE the lock. The check above and the write are
          // otherwise two separate moments, and a sign-in landing between them
          // would be replaced by an older login.
          if (credentialFingerprint(sibling.dir) !== retired) return;
          if (install(sibling.dir, snapshot)) updated.push(sibling.name);
        });
      } catch {
        // One profile failing must not stop the others: a login left behind is
        // exactly the problem being fixed.
      }
    }
  } finally {
    try {
      rmSync(snapshot, { force: true });
    } catch {
      /* the copy is temporary; failing to clear it changes nothing */
    }
  }
  return updated;
}
