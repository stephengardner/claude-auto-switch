import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { configHome, type PathCtx } from '../config/paths.js';
import { secureMkdir } from '../util/secret-file.js';

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

export interface CredentialEvent {
  /** When this happened, or when it last happened if it repeated. */
  at: number;
  account: string;
  kind: CredentialEventKind;
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
const MAX_BYTES = 256 * 1024;

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
  event: Omit<CredentialEvent, 'at' | 'count'> & { at?: number },
  c: PathCtx = {},
): void {
  try {
    const home = configHome(c);
    secureMkdir(home);
    const record: CredentialEvent = {
      at: event.at ?? Date.now(),
      account: event.account,
      kind: event.kind,
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
  const file = logPath(c);
  if (!existsSync(file)) return [];
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  if (text.length > MAX_BYTES) text = text.slice(-MAX_BYTES);
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
      previous.detail === event.detail;
    if (same) {
      out[out.length - 1] = { ...event, count: (previous.count ?? 1) + 1 };
    } else {
      out.push(event);
    }
  }
  return out;
}
