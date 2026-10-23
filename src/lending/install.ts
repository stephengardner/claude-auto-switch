import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { addAccount, getAccount, removeAccount, updateAccount } from '../accounts/registry.js';
import { readCredential, writeCredential } from '../accounts/credential-storage.js';
import {
  clearCredential,
  credentialPath,
  loginTextFingerprint,
  usableLoginText,
} from '../accounts/credential-vault.js';
import { logCredentialEvent } from '../accounts/credential-log.js';
import { CREDENTIALS_LOCK_DIR, acquireLockDir } from '../claude/locks.js';
import { carryIntoEditor } from '../editor/folder-login.js';
import { profilesDir, type PathCtx } from '../config/paths.js';
import { getActive, setActive } from '../state/active.js';
import { writeJsonFile } from '../util/fs-json.js';
import { secureMkdir, writeSecretFile } from '../util/secret-file.js';
import { assertInsideProfiles, assertProfileName } from '../util/names.js';
import { LendError } from '../util/errors.js';
import { lentCredentialText, type LendBundle } from './bundle.js';
import { LENT_HINT_FILE, lentLoginFromText } from './lent-login.js';
import { expiryWords } from './words.js';

/**
 * The receiving end of a lend: installing a login another machine lent this
 * one (`ccx lend import`), and taking it away again when that machine says so.
 *
 * Every write is made under the login lock Claude takes for its own (the same
 * one a renewal holds), and is refused, never waited past, when something else
 * holds it. A login of this machine's own is never replaced or removed: a lend
 * only ever takes the place of no login, or of an older lend.
 */

export interface Receiver {
  ctx: PathCtx;
  config: { profilesDir?: string };
}

export interface InstallResult {
  /** `unchanged`: what is installed already expires as late, so nothing was written. */
  status: 'installed' | 'updated' | 'unchanged';
  account: string;
  /** When the lent login now installed expires, epoch ms. */
  expiresAt: number;
}

export interface RemoveResult {
  /** `absent`: nothing lent was there to take away. */
  status: 'removed' | 'absent';
  account: string;
  /** Whether the account went too: only one the lend itself registered here. */
  deregistered: boolean;
}

interface Hint {
  /** The lend registered the account here, so taking it back removes the account too. */
  registeredByLend: boolean;
}

function readHint(dir: string): Hint | null {
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(dir, LENT_HINT_FILE), 'utf8'),
    ) as Partial<Hint>;
    return { registeredByLend: parsed.registeredByLend === true };
  } catch {
    return existsSync(path.join(dir, LENT_HINT_FILE)) ? { registeredByLend: false } : null;
  }
}

function writeHint(dir: string, hint: Hint): void {
  writeSecretFile(
    path.join(dir, LENT_HINT_FILE),
    `${JSON.stringify({ note: 'a login lent to this machine by another (ccx lend); the login is in .credentials.json', ...hint })}\n`,
  );
}

/** The login stored in `dir` as text, or null when there is none. */
function storedLogin(dir: string, name: string): string | null {
  try {
    return readCredential(credentialPath(dir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw new LendError(`"${name}": its login here could not be read, so nothing was changed`);
  }
}

function underLoginLock<T>(dir: string, name: string, work: () => T): T {
  const lock = acquireLockDir(path.join(dir, CREDENTIALS_LOCK_DIR));
  try {
    if (lock.unusable) {
      throw new LendError(
        `"${name}": its login folder could not be locked (${lock.unusable}), so nothing was changed`,
      );
    }
    if (!lock.held)
      throw new LendError(
        `"${name}": something else is writing its login right now; try again shortly`,
      );
    return work();
  } finally {
    lock.release();
  }
}

/** Who the account is, merged into the profile's `.claude.json` beside what is already there. */
function writeIdentity(dir: string, oauthAccount: Record<string, unknown> | undefined): void {
  if (!oauthAccount) return;
  const file = path.join(dir, '.claude.json');
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      existing = parsed as Record<string, unknown>;
  } catch {
    /* none yet */
  }
  writeJsonFile(file, { ...existing, oauthAccount });
}

/**
 * Install `bundle` as account `as` (its own name by default), registering the
 * account when this machine does not have it. Refused when the account has a
 * login of its own here, or is registered for a different address than the
 * lend is for. An older lend than the one installed changes nothing.
 */
export function installLend(
  bundle: LendBundle,
  receiver: Receiver,
  options: { as?: string; now?: number } = {},
): InstallResult {
  const name = options.as ?? bundle.account;
  assertProfileName(name);
  const { ctx } = receiver;
  const now = options.now ?? Date.now();
  const identityEmail = bundle.oauthAccount?.emailAddress;
  const email = bundle.email ?? (typeof identityEmail === 'string' ? identityEmail : undefined);
  const incoming = bundle.claudeAiOauth.expiresAt;

  let account = getAccount(name, ctx);
  if (
    account?.email &&
    email &&
    account.email.trim().toLowerCase() !== email.trim().toLowerCase()
  ) {
    throw new LendError(
      `"${name}" is registered here for ${account.email}, but this lend is for ${email}; nothing was installed`,
    );
  }
  let registered = false;
  if (!account) {
    const profiles = profilesDir(receiver.config, ctx);
    const dir = path.join(profiles, name);
    assertInsideProfiles(profiles, dir);
    secureMkdir(dir);
    account = addAccount({ name, dir, ...(email ? { email } : {}) }, ctx);
    registered = true;
  }
  const dir = account.dir;

  let result: InstallResult;
  try {
    result = underLoginLock(dir, name, (): InstallResult => {
      const before = storedLogin(dir, name);
      const lent = before === null ? null : lentLoginFromText(before);
      if (before !== null && lent === null && usableLoginText(before)) {
        throw new LendError(
          registered
            ? `${dir} still holds a login of its own, which a lend would replace; nothing was installed ` +
                '(import it under another name with --as, or remove that folder first)'
            : `"${name}" has its own login on this machine, which a lend would replace; nothing was installed ` +
                `(to take lends for it instead, remove it first: ccx remove ${name})`,
        );
      }
      if (lent && lent.expiresAt >= incoming)
        return { status: 'unchanged', account: name, expiresAt: lent.expiresAt };
      writeCredential(credentialPath(dir), lentCredentialText(bundle));
      writeHint(dir, { registeredByLend: registered || readHint(dir)?.registeredByLend === true });
      writeIdentity(dir, bundle.oauthAccount);
      // An editor on this account holds the lend this one replaces, which it
      // would keep using until it ran out: carried in, as a renewal is.
      const retired = lent && before !== null ? loginTextFingerprint(before) : null;
      if (retired) carryIntoEditor(ctx, dir)(retired, credentialPath(dir));
      return { status: registered ? 'installed' : 'updated', account: name, expiresAt: incoming };
    });
  } catch (error) {
    // Registered for this lend alone, so it goes with it: nothing is left behind that cannot work.
    if (registered) {
      try {
        removeAccount(name, ctx);
      } catch {
        /* the registry is as the error left it */
      }
    }
    throw error;
  }
  if (result.status !== 'unchanged') {
    if (!registered && !account.email && email) updateAccount(name, { email }, ctx);
    logCredentialEvent(
      {
        account: name,
        kind: 'installed',
        detail: `a login lent by another machine, ${expiryWords(incoming, now)}`,
      },
      ctx,
    );
  }
  return result;
}

/**
 * Take away the login another machine lent this one as `name`. The account
 * goes too when the lend registered it; one registered here before stays, with
 * no login. Refused for a login of this machine's own; nothing to do (absent)
 * when nothing lent is there.
 */
export function removeLend(name: string, receiver: Receiver): RemoveResult {
  assertProfileName(name);
  const { ctx } = receiver;
  const account = getAccount(name, ctx);
  if (!account) return { status: 'absent', account: name, deregistered: false };
  const dir = account.dir;
  const hint = readHint(dir);

  const removed = underLoginLock(dir, name, () => {
    const stored = storedLogin(dir, name);
    if (stored === null || lentLoginFromText(stored) === null) {
      if (stored !== null && usableLoginText(stored)) {
        throw new LendError(
          `"${name}" has its own login on this machine, which taking a lend back never removes`,
        );
      }
      // A lend whose login is gone already leaves only its hint; with no hint, nothing here was lent.
      if (hint === null) return false;
    }
    clearCredential(dir);
    rmSync(path.join(dir, LENT_HINT_FILE), { force: true });
    return true;
  });
  if (!removed) return { status: 'absent', account: name, deregistered: false };

  const deregister = hint?.registeredByLend === true;
  if (deregister) {
    removeAccount(name, ctx);
    if (getActive(ctx) === name) setActive(null, ctx);
  }
  logCredentialEvent({ account: name, kind: 'removed' }, ctx);
  return { status: 'removed', account: name, deregistered: deregister };
}
