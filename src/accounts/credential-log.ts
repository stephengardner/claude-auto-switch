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
  at: number;
  account: string;
  kind: CredentialEventKind;
  detail?: string;
}

const FILENAME = 'credential-log.jsonl';
/** Keep the tail readable; this is a diagnostic trail, not an archive. */
const MAX_BYTES = 256 * 1024;

function logPath(c: PathCtx = {}): string {
  return path.join(configHome(c), FILENAME);
}

/** Record one credential event. Never throws: logging must not break a swap. */
export function logCredentialEvent(event: Omit<CredentialEvent, 'at'> & { at?: number }, c: PathCtx = {}): void {
  try {
    const home = configHome(c);
    secureMkdir(home);
    const line = JSON.stringify({ at: event.at ?? Date.now(), ...event } satisfies CredentialEvent);
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
      if (typeof parsed.at === 'number' && typeof parsed.account === 'string') events.push(parsed);
    } catch {
      /* skip a truncated line */
    }
  }
  return events.slice(-limit);
}
