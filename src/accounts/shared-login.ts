import { installCredential, credentialFingerprint, credentialPath } from './credential-vault.js';
import { withCredentialLock } from '../claude/locks.js';

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
 * - the SOURCE is re-checked too, against the credential the renewal actually
 *   produced, so a profile whose login has since changed again never spreads a
 *   token nobody asked for.
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

  const updated: string[] = [];
  for (const sibling of siblings) {
    if (sibling.dir === renewedDir) continue;
    // Cheap check first, so the ordinary "nothing to do" case takes no lock.
    if (credentialFingerprint(sibling.dir) !== retired) continue;
    try {
      lock(sibling.dir, () => {
        // Re-checked INSIDE the lock, both ends. The check above and the write
        // are otherwise two separate moments, and anything can happen between
        // them: a sign-in on the sibling would be replaced by an older login,
        // and a second renewal on the source would spread a token nobody asked
        // for. Keeps the sibling's previous credential as a rollback cushion.
        if (credentialFingerprint(sibling.dir) !== retired) return;
        if (credentialFingerprint(renewedDir) !== renewed) return;
        if (install(sibling.dir, credentialPath(renewedDir))) updated.push(sibling.name);
      });
    } catch {
      // One profile failing must not stop the others: a login left behind is
      // exactly the problem being fixed.
    }
  }
  return updated;
}
