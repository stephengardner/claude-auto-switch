import { appendFileSync, readFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { configHome, type PathCtx } from '../config/paths.js';
import { secureMkdir, writeSecretFile } from '../util/secret-file.js';
import { acquireOwnedLock } from '../claude/locks.js';
import { isOnHold } from './on-hold.js';

/**
 * A record of everything that has happened to your logins.
 *
 * Losing a login is the most annoying thing this tool can do to you, and until
 * now it left no trace: a login simply stopped working and the only clue was
 * being asked to sign in again. This is the trail, so "why did I have to sign in
 * again?" has an answer instead of a shrug.
 *
 * Never contains tokens. Only what happened, to which account, and when.
 */

export type CredentialEventKind =
  /** A token was renewed (the old one stops working at that moment). */
  | 'renewed'
  /** Renewal was refused for good: this account has to be signed in again. */
  | 'needs-login'
  /** Renewal failed for a reason that may pass (offline, server error). */
  | 'renew-failed'
  /** A credential was written into a profile. */
  | 'installed'
  /** A credential was NOT written, because writing it would have done harm. */
  | 'refused'
  /** A previous credential was put back after something went wrong. */
  | 'rolled-back'
  /** The session was found signed out (a credential with no login in it). */
  | 'signed-out';

/**
 * WHY a credential event happened, as a value a program can rely on. The
 * `detail` beside it is the sentence for a person and may be reworded; this is
 * not. Each writer of this log records its own, so a record says which of
 * them wrote it and a reader never has to parse the sentence.
 */
export type CredentialEventReason =
  /** renewed: an idle login renewed as it fell due, during a usage refresh. */
  | 'idle-renewal'
  /** renewed: an expired login renewed as a session started on it. */
  | 'renewed-before-start'
  /** installed: a profile sharing a login that was just renewed was given the renewal. */
  | 'carried-shared-login'
  /** installed: a login renewed elsewhere was carried into a running session. */
  | 'carried-into-session'
  /** installed: a dead stored login was replaced by a running session's working one. */
  | 'adopted-from-session'
  /** installed: a renewal kept when its save failed was saved. */
  | 'kept-renewal-saved'
  /** installed: a login renewed elsewhere was carried into the editor's folder. */
  | 'carried-into-editor'
  /** installed: a login the editor's Claude renewed or kept was saved back to its profile. */
  | 'saved-from-editor'
  /** needs-login: Anthropic put the account on hold; signing in again does not bring it back. */
  | 'on-hold'
  /** needs-login: the login was refused for good, so the account has to be signed in again. */
  | 'renewal-refused'
  /** needs-login: there was no stored login to use. */
  | 'no-login'
  /** renew-failed: the renewal did not go through, for a reason that may pass (offline, a server error). */
  | 'renewal-unavailable'
  /** refused: a session is using the login, or a profile sharing it, so renewing would sign it out. */
  | 'session-using-it'
  /** refused: the editor is pointed at a profile sharing this login and may be using it. */
  | 'editor-may-be-using-it'
  /** refused: the editor holds a newer copy of this login that ccx could not yet confirm is this account's. */
  | 'editor-copy-unconfirmed'
  /** rolled-back: the stored login had been saved cut short, so the copy kept before it was put back. */
  | 'saved-cut-short'
  /** signed-out: the session had no login, so the stored one was left alone. */
  | 'session-had-no-login'
  /** A record this version cannot place: hand-edited, or from a writer it does not know. */
  | 'unknown';

/** Every reason, for a reader to check a value against. */
export const CREDENTIAL_EVENT_REASONS: readonly CredentialEventReason[] = [
  'idle-renewal',
  'renewed-before-start',
  'carried-shared-login',
  'carried-into-session',
  'adopted-from-session',
  'kept-renewal-saved',
  'carried-into-editor',
  'saved-from-editor',
  'on-hold',
  'renewal-refused',
  'no-login',
  'renewal-unavailable',
  'session-using-it',
  'editor-may-be-using-it',
  'editor-copy-unconfirmed',
  'saved-cut-short',
  'session-had-no-login',
  'unknown',
];

/** What a writer may record: every reason but the one kept for records nobody can place. */
export type WrittenCredentialReason = Exclude<CredentialEventReason, 'unknown'>;

export interface CredentialEvent {
  /** When this happened, or when it last happened if it repeated. */
  at: number;
  account: string;
  kind: CredentialEventKind;
  /** Why, as a value (see CredentialEventReason). */
  reason: CredentialEventReason;
  detail?: string;
  /**
   * How many times in a row the same thing was recorded. Absent means once.
   * Only ever produced when READING: every occurrence stays in the file, since
   * this is an audit trail and nothing about it is rewritten.
   */
  count?: number;
}

const FILENAME = 'credential-log.jsonl';
/** Keep the tail readable; this is a diagnostic trail, not an archive. */
export const MAX_BYTES = 256 * 1024;
/**
 * How large the live file grows before it is set aside (rotateIfLong). Twice
 * what a reader reads, so the archive and the live file together always hold
 * at least the last MAX_BYTES, and on disk the trail stays under three times it.
 */
export const ROTATE_BYTES = 2 * MAX_BYTES;
/** The last MAX_BYTES of the file before the live one. Only a rotation writes it. */
const ARCHIVE_SUFFIX = '.1';
/** Where the live file is parked mid-rotation, so a rotation stopped there loses nothing. */
const ROTATING_SUFFIX = '.rotating';
/** Held by a rotation only; an append never waits for it. */
const ROTATE_LOCK_SUFFIX = '.rotate.lock';

function logPath(c: PathCtx = {}): string {
  return path.join(configHome(c), FILENAME);
}

/**
 * Record one credential event. Never throws: logging must not break a swap.
 *
 * `count` is deliberately not accepted, and the written record is built field by
 * field rather than by spreading the caller's object. A count in this file would
 * be a lie: it is a READ-time summary of how many physical records repeated, so
 * persisting one would make two records display as many, and an audit trail that
 * overstates what happened is worse than no trail.
 */
export function logCredentialEvent(
  event: Omit<CredentialEvent, 'at' | 'count' | 'reason'> & { at?: number; reason: WrittenCredentialReason },
  c: PathCtx = {},
): void {
  try {
    const home = configHome(c);
    secureMkdir(home);
    // Before the line goes in, so the live file always ends with the newest one.
    rotateIfLong(c);
    const record: CredentialEvent = {
      at: event.at ?? Date.now(),
      account: event.account,
      kind: event.kind,
      reason: event.reason,
      ...(event.detail !== undefined ? { detail: event.detail } : {}),
    };
    const line = JSON.stringify(record);
    appendFileSync(logPath(c), `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    /* a missing trail is bad; a crash while writing it would be worse */
  }
}

/** The most recent events, oldest first. Unreadable lines are skipped. */
export function readCredentialEvents(limit = 50, c: PathCtx = {}): CredentialEvent[] {
  const text = readTail(c);
  const events: CredentialEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as CredentialEvent;
      if (typeof parsed.at === 'number' && typeof parsed.account === 'string') {
        // Built field by field so any count in the file is discarded. Physical
        // records never carry one, so a value here came from a hand-edited or
        // corrupted line, and honouring it would inflate the summary above what
        // actually happened.
        events.push({
          at: parsed.at,
          account: parsed.account,
          kind: parsed.kind,
          // Recorded since 2.6.33; worked out from what was written before that.
          reason: storedReason(parsed.reason) ?? legacyReason(parsed.kind, parsed.detail),
          ...(parsed.detail !== undefined ? { detail: parsed.detail } : {}),
        });
      }
    } catch {
      /* skip a truncated line */
    }
  }
  return foldRepeats(events).slice(-limit);
}

/**
 * Collapse consecutive identical events for DISPLAY, keeping a count and the
 * time of the most recent one.
 *
 * The file itself is untouched: this is an append-only audit trail, and folding
 * it on write would turn a cheap append into a read on the credential path. On
 * read it costs nothing and rescues what is already written, which is the point,
 * because `ccx history` is read exactly when something has gone wrong and a run
 * of one repeated line is what pushes the useful entries off the screen.
 */
function foldRepeats(events: CredentialEvent[]): CredentialEvent[] {
  const out: CredentialEvent[] = [];
  for (const event of events) {
    const previous = out[out.length - 1];
    const same =
      previous &&
      previous.account === event.account &&
      previous.kind === event.kind &&
      previous.reason === event.reason &&
      previous.detail === event.detail;
    if (same) {
      out[out.length - 1] = { ...event, count: (previous.count ?? 1) + 1 };
    } else {
      out.push(event);
    }
  }
  return out;
}

/**
 * Keep the file bounded. Until 2.6.33 every event since the first was kept,
 * while every reader only ever read the last MAX_BYTES: one machine's file had
 * 43,504 lines, 4.2 MB over 85 days. Past ROTATE_BYTES the live file is set
 * aside and its last MAX_BYTES become the archive, so what a reader reads is
 * always there and nothing older is.
 *
 * The common path is one stat. The live file is moved aside in one step, so an
 * append that races it lands in one file or the other and is never lost; the
 * lock is a rotation's alone, and is never waited for, so an append on the
 * credential path never waits either. A rotation stopped part way leaves every
 * line in a file readers still read, and the next one finishes it. Best effort
 * throughout: a trail that stays long for now is no harm.
 *
 * Exported so a test can rotate at a chosen moment, as another process would.
 */
export function rotateIfLong(c: PathCtx = {}): void {
  try {
    const file = logPath(c);
    if (statSync(file).size <= ROTATE_BYTES) return;
    const lock = acquireOwnedLock(`${file}${ROTATE_LOCK_SUFFIX}`, { waitMs: 0, staleMs: 5_000 });
    if (!lock.held) return;
    try {
      if (existsSync(`${file}${ROTATING_SUFFIX}`)) archiveRotating(file);
      if (statSync(file).size <= ROTATE_BYTES) return; // another rotation just finished
      renameSync(file, `${file}${ROTATING_SUFFIX}`);
      archiveRotating(file);
    } finally {
      lock.release();
    }
  } catch {
    /* the file stays long until a later append manages it; nothing is lost by that */
  }
}

/** Write the tail of the parked file as the archive, then remove it. */
function archiveRotating(file: string): void {
  const rotating = `${file}${ROTATING_SUFFIX}`;
  writeSecretFile(`${file}${ARCHIVE_SUFFIX}`, tailLines(readFileSync(rotating, 'utf8'), MAX_BYTES));
  rmSync(rotating, { force: true });
}

/** At most the last `max` characters of `text`, starting at a whole line. */
function tailLines(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(-max);
  const newline = cut.indexOf('\n');
  return newline === -1 ? '' : cut.slice(newline + 1);
}

/**
 * The last MAX_BYTES of the trail: the live file, then, while that holds less,
 * a rotation stopped part way and the archive before it. Each piece is read
 * whole or not at all, and joined so no line runs into the next.
 */
function readTail(c: PathCtx): string {
  const file = logPath(c);
  let text = '';
  for (const part of [file, `${file}${ROTATING_SUFFIX}`, `${file}${ARCHIVE_SUFFIX}`]) {
    if (text.length >= MAX_BYTES) break;
    if (!existsSync(part)) continue;
    try {
      const older = readFileSync(part, 'utf8');
      text = (older === '' || older.endsWith('\n') ? older : `${older}\n`) + text;
    } catch {
      /* an unreadable piece must not lose the readable ones */
    }
  }
  return text.length > MAX_BYTES ? text.slice(-MAX_BYTES) : text;
}

function storedReason(value: unknown): CredentialEventReason | undefined {
  return CREDENTIAL_EVENT_REASONS.find((reason) => reason === value);
}

/**
 * The reason for a record written before ccx recorded one, from its kind and
 * the words written beside it then. Frozen on purpose: those records never
 * change, so this matches what WAS written, and a later rewording of a writer
 * does not belong here. Anything it cannot place is `unknown`, never a guess.
 */
function legacyReason(kind: unknown, detail: string | undefined): CredentialEventReason {
  const said = detail ?? '';
  switch (kind) {
    case 'renewed':
      if (detail === undefined) return 'idle-renewal';
      return said === 'expired login renewed before starting' ? 'renewed-before-start' : 'unknown';
    case 'installed':
      if (said.startsWith('shares a login with ')) return 'carried-shared-login';
      if (said.startsWith('the stored login was renewed elsewhere; carried into this running session')) {
        return 'carried-into-session';
      }
      if (said.startsWith('the stored login was dead, but the live session')) return 'adopted-from-session';
      if (said === 'a renewal kept when its save failed, saved now') return 'kept-renewal-saved';
      if (said === 'the stored login was renewed elsewhere; carried into the editor') return 'carried-into-editor';
      if (said.startsWith('the editor ')) return 'saved-from-editor';
      return 'unknown';
    case 'needs-login':
      if (isOnHold(detail)) return 'on-hold';
      return said === 'no stored login' ? 'no-login' : 'renewal-refused';
    case 'renew-failed':
      return 'renewal-unavailable';
    case 'refused':
      if (said.startsWith('not renewed: a session is using ')) return 'session-using-it';
      if (said.startsWith('not renewed: your editor is pointed at ')) return 'editor-may-be-using-it';
      if (said.startsWith('not renewed: your editor holds a newer copy ')) return 'editor-copy-unconfirmed';
      return 'unknown';
    case 'rolled-back':
      return said.startsWith('the stored login had been saved cut short') ? 'saved-cut-short' : 'unknown';
    case 'signed-out':
      return said.startsWith('session had no login') ? 'session-had-no-login' : 'unknown';
    default:
      return 'unknown';
  }
}
