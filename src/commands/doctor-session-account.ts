import { hasCredential } from '../accounts/credential-storage.js';
import path from 'node:path';
import { credentialFingerprint } from '../accounts/credential-vault.js';
import { thrownReason } from '../util/thrown-reason.js';
import type { DoctorCheck } from './doctor.js';

/**
 * Is each running session using the account ccx gave it?
 *
 * Every session has a folder of its own, and starting it, or moving it to
 * another account, copies that account's login into the folder and records the
 * account in the session's lease. The two can only disagree when something
 * went wrong: a login copied into the wrong folder, or a move that changed one
 * and not the other. A session in that state runs on somebody else's login
 * while ccx reports the account it chose, and a limit hit there is recorded
 * against the wrong account.
 *
 * Each session is compared with its OWN account. Comparing with the account
 * new sessions start on (the "active" one) was right when every session shared
 * one folder; with a folder each, sessions on different accounts are the point,
 * and that comparison reported a problem on every second terminal.
 *
 * Deliberately local and read-only: fingerprints of files already on disk, no
 * network, no renewal. `ccx doctor` is what someone runs when a session behaved
 * oddly, and it must never change anything while answering.
 */

export interface SessionAccountInput {
  accounts: Array<{ name: string; dir: string }>;
  /**
   * The sessions running right now: the account ccx gave each, and the folder
   * it reads its login from. Two of them pointed at ONE folder is a collision of
   * its own, and it is said before anything else: only one login can be in it.
   */
  leases: Array<{ account: string; pid: number; configDir: string }>;
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
  const exists = input.exists ?? hasCredential;

  // Checked first, because it explains every other symptom: whichever account
  // the comparison below reports, the other sessions are not on it.
  const shared = sessionsSharingOneDirectory(input.leases, input.platform ?? process.platform);
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

  if (input.leases.length === 0) return { name, ok: true, detail: 'no session is running' };

  const wrong: string[] = [];
  // What could be checked, said as it is: a session passed over is not one
  // found to be on its own account.
  const tally = { verified: 0, renewed: 0, unreadable: 0 };
  for (const lease of input.leases) {
    let present: boolean;
    try {
      present = exists(path.join(lease.configDir, '.credentials.json'));
    } catch (error) {
      return {
        name,
        ok: false,
        detail: `could not check the login of session ${lease.pid}: ${thrownReason(error)}`,
      };
    }
    // Starting, or between accounts: nothing to compare yet.
    const login = present ? fingerprintOf(lease.configDir) : null;
    if (!login) {
      tally.unreadable += 1;
      continue;
    }
    const holders = input.accounts
      .filter((account) => fingerprintOf(account.dir) === login)
      .map((account) => account.name);
    // A login no profile holds is ordinary: a running Claude renews its own
    // token, and it is newer than the stored copy until it is saved back.
    // Saying "unrecognised" here would cry wolf every few hours.
    if (holders.length === 0) {
      tally.renewed += 1;
      continue;
    }
    // Two profiles holding one login is not this session's problem.
    if (holders.includes(lease.account)) {
      tally.verified += 1;
      continue;
    }
    wrong.push(
      `session ${lease.pid} was given "${lease.account}" but holds the login of ` +
        holders.map((h) => `"${h}"`).join(' or '),
    );
  }

  if (wrong.length === 0) return { name, ok: true, detail: describeTally(tally) };

  return {
    name,
    ok: false,
    detail: `${wrong.join('; ')}. A limit hit there would be recorded against the wrong account.`,
    fix: ['end that session and start it again: it picks its account up afresh'],
  };
}

/** What the check found, session by session, in a sentence. */
function describeTally(tally: { verified: number; renewed: number; unreadable: number }): string {
  const parts: string[] = [];
  if (tally.verified > 0) {
    parts.push(
      tally.verified === 1
        ? '1 holds the login of the account it was given'
        : `${tally.verified} hold the login of the account each was given`,
    );
  }
  if (tally.renewed > 0) {
    parts.push(
      `${tally.renewed} renewed ${tally.renewed === 1 ? 'its' : 'their'} login in place (newer than any stored copy)`,
    );
  }
  if (tally.unreadable > 0) {
    parts.push(`${tally.unreadable} ${tally.unreadable === 1 ? 'has' : 'have'} no readable login yet`);
  }
  const total = tally.verified + tally.renewed + tally.unreadable;
  return `${total} running session${total === 1 ? '' : 's'}: ${parts.join(', ')}`;
}

/**
 * Are two or more running sessions pointed at the same session directory?
 *
 * Each session has a directory of its own, so this should never happen; a
 * session started by a version of ccx from before the split still uses the one
 * shared directory, and two of those collide.
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
