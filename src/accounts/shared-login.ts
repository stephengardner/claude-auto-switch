import { installCredential, credentialFingerprint, credentialPath } from './credential-vault.js';

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
 * Copy a freshly renewed login into the profiles that were sharing the one it
 * replaced. Returns the names actually updated.
 *
 * `retiredFingerprint` is the identity of the credential BEFORE the renewal,
 * and a profile is only written when it still holds exactly that. Anything else
 * means the profile is not what it was when this started, and writing over it
 * would be a guess about someone's login. Guessing is what scrambled these
 * profiles once before, so the condition is exact rather than approximate.
 */
export function propagateRenewal(
  renewedDir: string,
  siblings: SharedProfile[],
  retiredFingerprint: string | null,
): string[] {
  const updated: string[] = [];
  for (const sibling of siblings) {
    if (sibling.dir === renewedDir) continue;
    // A null fingerprint needs no branch of its own: a readable profile never
    // fingerprints to null, so this comparison already refuses everything.
    if (credentialFingerprint(sibling.dir) !== retiredFingerprint) continue;
    try {
      // Keeps the sibling's previous credential as a rollback cushion, and
      // refuses a source that is empty or unreadable.
      if (installCredential(sibling.dir, credentialPath(renewedDir))) updated.push(sibling.name);
    } catch {
      // One profile failing must not stop the others: a login left behind is
      // exactly the problem being fixed.
    }
  }
  return updated;
}
