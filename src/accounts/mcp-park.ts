import path from 'node:path';
import { CREDENTIALS_LOCK_DIR, lockDirSteps } from '../claude/locks.js';
import type { Steps } from '../util/steps.js';
import { readCredentialSteps, writeCredentialSteps } from './credential-storage.js';
import { credentialPath, REREAD_PLACEHOLDER } from './credential-vault.js';
import type { KeychainIo } from './keychain-view.js';
import { holdsMcpLogins, holdsMcpLoginsOf, parkMcpLogins } from './mcp-logins.js';

/** The saved login at `file`, or `absent` when there is none; throws when it cannot be read. */
function* savedLoginOr(file: string, absent: string, io: KeychainIo): Steps<string> {
  try {
    return yield* readCredentialSteps(file, io);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return absent;
    throw error;
  }
}

/**
 * Park the MCP sign-ins in `ending`, the login text of a folder that is going,
 * in the saved login of the account in `accountDir`, on their own: its Claude
 * login stays as it is, whether or not the folder's is one to save (parkMcpLogins
 * joins them server by server). Done under the saved login's lock, and merged
 * with the login as it is when it is written. An account with no saved login
 * gets one of sign-ins only, which is no Claude login.
 *
 * True once they were written, false when there was nothing to park or the
 * saved login held them already. Throws when they could not be kept: the saved
 * login is being changed, cannot be read, or is not a login that can hold them.
 * `waitMs` is how long its lock is waited for.
 */
export function* parkMcpLoginsSteps(
  accountDir: string,
  ending: string,
  io: KeychainIo,
  options: { waitMs?: number } = {},
): Steps<boolean> {
  if (!holdsMcpLogins(ending)) return false;
  const lock = yield* lockDirSteps(path.join(accountDir, CREDENTIALS_LOCK_DIR), {
    ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
  });
  if (!lock.held) throw new Error('its saved login is being changed');
  try {
    const file = credentialPath(accountDir);
    const saved = yield* savedLoginOr(file, REREAD_PLACEHOLDER, io);
    if (parkMcpLogins(saved, ending) === saved) {
      if (holdsMcpLoginsOf(saved, ending)) return false;
      throw new Error('its saved login is not one that can hold them');
    }
    // A store emptied since it was read is empty, not what it held then.
    yield* writeCredentialSteps(
      file,
      (current) => parkMcpLogins(current ?? REREAD_PLACEHOLDER, ending),
      io,
    );
    return true;
  } finally {
    lock.release();
  }
}
