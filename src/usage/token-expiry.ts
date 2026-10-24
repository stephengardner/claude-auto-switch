import { readCredential, readCredentialSteps } from '../accounts/credential-storage.js';
import type { KeychainIo } from '../accounts/keychain-view.js';
import type { Steps } from '../util/steps.js';

/**
 * When the access token in a credential file expires, as epoch ms, or 0 when
 * the file is missing, unreadable, or carries no expiry.
 *
 * Zero rather than null so freshness comparisons stay plain arithmetic: an
 * unknown expiry loses to any known one, which is the safe direction (a copy
 * we cannot date is never treated as the newer one).
 */
export function readExpiresAt(credentialsFile: string): number {
  try {
    return loginExpiresAt(readCredential(credentialsFile));
  } catch {
    return 0;
  }
}

/** readExpiresAt as steps, the Keychain reached through `io`. */
export function* readExpiresAtSteps(credentialsFile: string, io: KeychainIo): Steps<number> {
  try {
    return loginExpiresAt(yield* readCredentialSteps(credentialsFile, io));
  } catch {
    return 0;
  }
}

/** readExpiresAt for a login already read, as text. */
export function loginExpiresAt(text: string): number {
  try {
    const parsed = JSON.parse(text) as {
      claudeAiOauth?: { expiresAt?: unknown };
    };
    const at = parsed.claudeAiOauth?.expiresAt;
    return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : 0;
  } catch {
    return 0;
  }
}
