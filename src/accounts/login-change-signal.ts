import { existsSync, utimesSync } from 'node:fs';
import { writeSecretFile } from '../util/secret-file.js';
import { credentialPath } from './credential-vault.js';
import { readKeychainCredential } from './keychain.js';

/**
 * Make a running Claude use, from its very next call, the login that was just
 * put in its folder.
 *
 * Claude keeps the login it read, and drops it early only when the time on
 * `.credentials.json` in its config folder changes. Where that file is the
 * login, writing the login changes the time, and a page published 51 ms
 * after a move went out as the new account (Claude Code 2.1.296).
 *
 * On macOS a session's login moves into the Keychain once Claude saves it
 * itself, and the file goes. ccx then writes the login into the Keychain, the
 * file's time does not change, and Claude goes on with the login it read for
 * up to 30 seconds. Measured on 2.1.296 with the login in the Keychain: a
 * publish 51 ms after a move went out as the account the session had just
 * left, a read made after an unsignalled move was answered as that account,
 * and a read made after a signalled one was answered as the new account.
 *
 * So when the login lives in the Keychain, the file's time is moved too: an
 * empty file when there is none (it holds no login, and Claude reads the
 * Keychain first), or only the time of one that is there.
 *
 * Returns where the login lives. Throws when the time could not be moved,
 * because the caller is about to rely on Claude having noticed.
 */
export function signalLoginChange(
  configDir: string,
  deps: { keychainHolds?: (dir: string) => boolean; now?: () => Date } = {},
): 'file' | 'keychain' {
  const keychainHolds = deps.keychainHolds ?? ((dir: string) => readKeychainCredential(dir) !== null);
  // The file is the login, and writing the login changed its time.
  if (!keychainHolds(configDir)) return 'file';
  const file = credentialPath(configDir);
  if (existsSync(file)) {
    const at = (deps.now ?? (() => new Date()))();
    utimesSync(file, at, at);
  } else {
    writeSecretFile(file, '{}');
  }
  return 'keychain';
}
