/**
 * Remembering that a particular stored login is beyond saving.
 *
 * When the token endpoint answers `invalid_grant`, that refresh token is gone
 * for good. No number of retries can change the answer; only signing in again
 * can, and signing in REWRITES the credential file. So the refusal is
 * remembered against the file's contents, and forgotten the moment those
 * contents change. This is the same rule the save-back guard uses: a refusal
 * cannot change until the file does.
 *
 * The memory is per process and deliberately not written to disk. The retries
 * this exists to stop are overwhelmingly one long-running session re-checking
 * the same dead login every few minutes: in the log that motivated this, 98% of
 * them came less than six minutes apart, in bursts of about fifty. A fresh
 * process re-checking once is not a problem worth a state file, and forgetting
 * on restart means a login repaired by other means is never held down by a
 * stale note.
 */

const refused = new Map<string, string>();

/**
 * Has this exact credential already been refused as unrecoverable?
 *
 * `fingerprint` identifies the credential's CONTENTS, so a renewed or
 * re-authenticated login is a different value and is tried again.
 */
export function alreadyRefused(fingerprint: string | null): boolean {
  return fingerprint !== null && refused.has(fingerprint);
}

/** The reason this credential was refused, for reporting it once. */
export function refusalReason(fingerprint: string | null): string | undefined {
  return fingerprint === null ? undefined : refused.get(fingerprint);
}

/** Record that this credential is beyond renewal, with why. */
export function rememberRefused(fingerprint: string | null, detail: string): void {
  if (fingerprint !== null) refused.set(fingerprint, detail);
}

/**
 * Forget everything. Only for tests: a process that has seen a dead login
 * should keep knowing it, and each test needs to start from nothing.
 */
export function forgetRefusals(): void {
  refused.clear();
}
