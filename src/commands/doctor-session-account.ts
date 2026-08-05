import { existsSync } from 'node:fs';
import path from 'node:path';
import { credentialFingerprint } from '../accounts/credential-vault.js';
import type { DoctorCheck } from './doctor.js';

/**
 * Is the running session using the account ccx thinks it is?
 *
 * Every `ccx run` shares ONE session directory, and starting a session copies
 * that account's login into it. Two sessions at once therefore write the same
 * file, and the second one silently takes the first one's account: the first
 * terminal keeps running, on somebody else's login, while ccx still reports the
 * account it chose. A limit hit there is recorded against the wrong account.
 *
 * The save-back guard already refuses to write the borrowed login into the
 * wrong profile, so nothing is corrupted by it. What was missing is any way to
 * SEE it, which is what this reports.
 *
 * Deliberately local and read-only: fingerprints of files already on disk, no
 * network, no renewal. `ccx doctor` is what someone runs when a session behaved
 * oddly, and it must never change anything while answering.
 */

export interface SessionAccountInput {
  sessionDir: string;
  activeAccount: string | null;
  accounts: Array<{ name: string; dir: string }>;
  /**
   * The sessions running right now. Two of them pointed at ONE directory is the
   * collision itself, and it is worth saying before anything else: only one
   * login can be in that directory, so the others are running as somebody else.
   */
  leases?: Array<{ account: string; pid: number; configDir: string }>;
  /**
   * Which filesystem's rules apply when comparing directories. Windows treats
   * two spellings of one path as the same directory; POSIX does not, and
   * folding case there would merge /tmp/Session with /tmp/session and report a
   * collision between two perfectly good sessions.
   */
  platform?: NodeJS.Platform;
  /** Injected so the check is testable without building credential files. */
  fingerprintOf?: (dir: string) => string | null;
  exists?: (file: string) => boolean;
}

export function auditSessionAccount(input: SessionAccountInput): DoctorCheck {
  const name = 'session-account';
  const fingerprintOf = input.fingerprintOf ?? credentialFingerprint;
  const exists = input.exists ?? existsSync;

  // Checked first, because it explains every other symptom: whichever account
  // the credential comparison below reports, the other sessions are not on it.
  const shared = sessionsSharingOneDirectory(input.leases ?? [], input.platform ?? process.platform);
  if (shared) {
    return {
      name,
      ok: false,
      detail:
        `${shared.sessions} sessions are sharing one session directory (${shared.accounts.join(', ')}). ` +
        'Only one login fits in it, so the others are running on an account they were not given. ' +
        'A limit hit now would be recorded against the wrong account.',
      fix: ['end all but one ccx session, then start the others again'],
    };
  }

  if (!exists(path.join(input.sessionDir, '.credentials.json'))) {
    return { name, ok: true, detail: 'no session is running' };
  }

  const sessionLogin = fingerprintOf(input.sessionDir);
  if (!sessionLogin) {
    return { name, ok: true, detail: 'the session has no readable login (it may be starting)' };
  }

  const holders = input.accounts
    .filter((account) => fingerprintOf(account.dir) === sessionLogin)
    .map((account) => account.name);

  if (holders.length === 0) {
    // Ordinary and not a fault: a running Claude renews its own token, so the
    // session's login is newer than the copy in the profile until it is saved
    // back. Saying "unrecognised" here would cry wolf every few hours.
    return {
      name,
      ok: true,
      detail: 'the session login is newer than any stored copy (renewed in place)',
    };
  }

  if (input.activeAccount && holders.includes(input.activeAccount)) {
    const alsoHeldBy = holders.filter((h) => h !== input.activeAccount);
    return {
      name,
      ok: true,
      detail: alsoHeldBy.length
        ? `running as "${input.activeAccount}" (a login it shares with ${alsoHeldBy.join(', ')})`
        : `running as "${input.activeAccount}"`,
    };
  }

  return {
    name,
    ok: false,
    detail:
      `the running session is using ${holders.map((h) => `"${h}"`).join(' or ')}, ` +
      `but the active account is "${input.activeAccount ?? 'none'}". Two sessions share one ` +
      'session directory, so a later one took this terminal\'s account. A limit hit now would ' +
      'be recorded against the wrong account.',
    fix: ['end one of the running ccx sessions, then start it again'],
  };
}

/**
 * Are two or more running sessions pointed at the same session directory?
 *
 * Each `ccx run` records the directory it is using. They all use the same one
 * today, so this is really "is more than one session running", but it is phrased
 * as the invariant rather than the count: the day sessions get a directory each,
 * this check keeps meaning the right thing instead of firing on every second
 * terminal.
 */
function sessionsSharingOneDirectory(
  leases: Array<{ account: string; pid: number; configDir: string }>,
  platform: NodeJS.Platform,
): { sessions: number; accounts: string[] } | null {
  const windows = platform === 'win32';
  const byDirectory = new Map<string, string[]>();
  for (const lease of leases) {
    // Case folded ONLY on Windows, where two spellings are one directory. Doing
    // it everywhere would merge /tmp/Session with /tmp/session on Linux and
    // report a collision between two sessions that are not colliding, then tell
    // the operator to stop one of them.
    const normalised = windows ? lease.configDir.split('\\').join('/') : lease.configDir;
    const key = windows ? normalised.toLowerCase() : normalised;
    byDirectory.set(key, [...(byDirectory.get(key) ?? []), `${lease.account} (pid ${lease.pid})`]);
  }
  for (const accounts of byDirectory.values()) {
    if (accounts.length > 1) return { sessions: accounts.length, accounts };
  }
  return null;
}
