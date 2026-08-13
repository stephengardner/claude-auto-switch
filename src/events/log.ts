import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync, renameSync, rmSync } from 'node:fs';
import { acquireLockDir } from '../claude/locks.js';
import path from 'node:path';
import { writeSecretFile } from '../util/secret-file.js';

/**
 * A tiny append-only event log shared between processes: `ccx run` writes swap
 * events here, and the dashboard (a separate process) tails it so you can watch
 * swaps happen live. Bounded so it never grows without limit; owner-only.
 */
const FILE = 'events.jsonl';
/** The compacted older half. Only compaction writes it; appends never do. */
const ARCHIVE_SUFFIX = '.1';
/** Where the live file is parked mid-compaction, so a crash there loses nothing. */
const ROTATING_SUFFIX = '.rotating';
/** Held only while compacting, so two processes cannot rotate at once. */
const LOCK_SUFFIX = '.compact.lock';
const MAX = 200;

export interface EventRecord {
  /** When this event last happened. */
  at: number;
  msg: string;
  /**
   * How many times in a row this same message has arrived. Absent means once,
   * so records written before this existed still read correctly.
   */
  count?: number;
  /**
   * What KIND of thing happened (cap-verify, credential-sync, identity-mismatch,
   * ...), so the log can be filtered by decision rather than by prose.
   */
  kind?: string;
  /**
   * The evidence the decision was based on: the numbers, names and verdicts as
   * they were at that moment. The message stays the human sentence; this is what
   * lets "why did it do that?" be answered from the log alone instead of by
   * reproducing the moment.
   */
  data?: Record<string, unknown>;
}

/** The structured half of an event, alongside its human-readable message. */
export interface EventDetail {
  kind?: string;
  data?: Record<string, unknown>;
}

export function eventsFilePath(configHome: string): string {
  return path.join(configHome, FILE);
}

/**
 * Fold consecutive identical messages into one record, summing their counts and
 * keeping the most recent time.
 *
 * Applied on READ as well as on write, because a log written before collapsing
 * existed is already full of separate lines, and that is exactly the log worth
 * rescuing: a window holding two hundred copies of one message shows nothing
 * else until every one of them ages out. Folding on read makes it readable
 * immediately, without rewriting a file the operator may still be watching.
 */
function foldRepeats(records: EventRecord[]): EventRecord[] {
  const out: EventRecord[] = [];
  for (const record of records) {
    const previous = out[out.length - 1];
    if (previous && previous.msg === record.msg) {
      // Clamped, because the sum of two counts read from a file can leave the
      // safe-integer range, and a count that is not a safe integer is dropped on
      // the next read, turning "a great many" into "once". No real log reaches
      // this (the file holds 200 records, so it would take quadrillions of
      // appends), but the input is a file and anything can write one. Clamping
      // rather than splitting the record because past that size the difference
      // between two counts carries no meaning worth preserving.
      const total = (previous.count ?? 1) + (record.count ?? 1);
      out[out.length - 1] = {
        at: record.at,
        msg: record.msg,
        count: Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER,
        // The newest occurrence's evidence, matching `at`: when the same thing
        // has happened forty times, the state as of the LAST time is the one
        // that answers "is this still going, and why".
        ...(record.kind ? { kind: record.kind } : {}),
        ...(record.data ? { data: record.data } : {}),
      };
    } else {
      out.push(record);
    }
  }
  return out;
}

/**
 * Read the last `limit` events, oldest first, skipping any malformed lines.
 *
 * The limit counts records AFTER folding repeats, so asking for five events
 * gives five things that happened rather than five copies of one of them.
 */
export function readEvents(configHome: string, limit = 5): EventRecord[] {
  const file = eventsFilePath(configHome);
  // Oldest first: the compacted archive, then anything a compaction was moving
  // when it was interrupted, then the live file. Reading the middle one is what
  // makes a compaction killed half way through cost nothing.
  const parts = [`${file}${ARCHIVE_SUFFIX}`, `${file}${ROTATING_SUFFIX}`, file];
  const chunks: string[] = [];
  for (const part of parts) {
    if (!existsSync(part)) continue;
    try {
      chunks.push(readFileSync(part, 'utf8'));
    } catch {
      /* an unreadable piece must not lose the readable ones */
    }
  }
  if (chunks.length === 0) return [];
  return foldRepeats(parseRecords(joinChunks(chunks))).slice(-limit);
}

/**
 * Parse the file into records, skipping any malformed line.
 *
 * A concurrent append can leave a partial line behind on some systems, and a
 * line can be hand-edited, so nothing here may assume the file is well formed.
 */
function parseRecords(text: string): EventRecord[] {
  const out: EventRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Partial<EventRecord>;
      if (typeof r.at === 'number' && typeof r.msg === 'string') {
        out.push({
          at: r.at,
          msg: r.msg,
          // A count has to be a whole number above one. Anything else came from
          // a corrupted or hand-edited line, and carrying it through would show
          // "(x2.5)" to the operator, or serialise Infinity back out as null.
          ...(Number.isSafeInteger(r.count) && (r.count as number) > 1
            ? { count: r.count as number }
            : {}),
          ...(typeof r.kind === 'string' && r.kind.length > 0 ? { kind: r.kind } : {}),
          // A plain object only. Anything else (a string, an array, null) came
          // from a hand-edited line, and rendering it later would surprise.
          ...(r.data && typeof r.data === 'object' && !Array.isArray(r.data)
            ? { data: r.data as Record<string, unknown> }
            : {}),
        });
      }
    } catch {
      /* skip a malformed line */
    }
  }
  return out;
}

/**
 * How large the file may get before it is worth trimming, in bytes.
 *
 * Measured in BYTES because that is what `stat` gives for free. Counting lines
 * means reading the whole file, and doing that on every append is how the first
 * version of this turned a cheap write back into an expensive one: 900 appends
 * took over twenty seconds. Size is O(1) to ask for, so the common path never
 * opens the file at all.
 *
 * Generous on purpose. Trimming rewrites the file, so it should be rare, and a
 * few hundred kilobytes of text costs nothing to hold.
 */
/** Exported so tests assert the real bound rather than a copy of the number. */
export const TRIM_BYTES = 64 * 1024;

/**
 * Append one event.
 *
 * A TRUE append, one line, and never a read-modify-write of the whole file.
 * Several ccx processes share this log (a session, the dashboard tailing it, the
 * editor launcher), and rewriting the file from each of them was wrong in two
 * ways at once, both reproduced with four concurrent writers:
 *
 * - it LOST events. Two writers read the same state and the second rewrite
 *   erased the first one's event. 74% of events disappeared.
 * - it THREW. The atomic rewrite renames a temp file onto the target, and on
 *   Windows that fails with EPERM when another process is doing the same. Three
 *   of four writers crashed. Nothing here was wrapped, so a log line could take
 *   down a session start or a swap.
 *
 * An append cannot collide with another append and needs no temp file, so both
 * go away. Writing is best effort besides: telemetry must never be able to stop
 * the thing it is describing.
 */
export function appendEvent(
  configHome: string,
  msg: string,
  now: number,
  detail: EventDetail = {},
): void {
  const file = eventsFilePath(configHome);
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const record = {
      at: now,
      msg,
      ...(detail.kind ? { kind: detail.kind } : {}),
      ...(detail.data ? { data: detail.data } : {}),
    };
    appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    return; // a lost log line must never break a session
  }
  trimIfLong(file);
}

/**
 * Keep the file bounded, occasionally.
 *
 * Repeats are FOLDED before the tail is taken, which is the part that matters: a
 * caller stuck in a loop used to fill every slot and push out everything else,
 * blinding `ccx dashboard` and `ccx history` exactly when they were the tools
 * being reached for. That has happened twice. Folding first means a storm
 * occupies ONE record no matter how long it runs, so real events survive it.
 *
 * Best effort throughout. A trim that collides with another process just leaves
 * the file long for now, and the next append tries again.
 */
function trimIfLong(file: string): void {
  try {
    // The whole point of the cheap path: ask the size, do not read the file.
    if (statSync(file).size <= TRIM_BYTES) return;

    // One compactor at a time, and never waiting: if someone else is doing it,
    // there is nothing to add by queueing up behind them.
    const lock = acquireLockDir(`${file}${LOCK_SUFFIX}`, { waitMs: 0 });
    if (!lock.held) return;
    try {
      if (statSync(file).size <= TRIM_BYTES) return; // they may have just finished

      // The live file is moved ASIDE in one atomic step rather than read and
      // replaced. Snapshot-then-replace loses any event appended in between,
      // which is the same lost-update bug this change removes from the write
      // path, and it would have been reintroduced here where it is harder to
      // see. After the rename, appends create a fresh file that compaction
      // never touches, so nothing arriving from here on can be overwritten.
      const rotating = `${file}${ROTATING_SUFFIX}`;
      const archive = `${file}${ARCHIVE_SUFFIX}`;
      renameSync(file, rotating);

      const older = existsSync(archive) ? readFileSync(archive, 'utf8') : '';
      const kept = foldRepeats(
        parseRecords(joinChunks([older, readFileSync(rotating, 'utf8')])),
      ).slice(-MAX);
      writeSecretFile(archive, `${kept.map((r) => JSON.stringify(r)).join('\n')}\n`);
      rmSync(rotating, { force: true });
    } finally {
      lock.release();
    }
  } catch {
    /* the file stays long until someone manages it; nothing is lost by that */
  }
}

/**
 * Join file chunks so a line cannot be spliced onto the one after it. A chunk
 * that does not end in a newline would otherwise merge its last record with the
 * next chunk's first, and both would be discarded as malformed.
 */
function joinChunks(chunks: string[]): string {
  return chunks
    .filter((c) => c.length > 0)
    .map((c) => (c.endsWith('\n') ? c : `${c}\n`))
    .join('');
}

/**
 * Format an event as `HH:MM  message` in local time, with a repeat count when
 * the same thing has happened more than once in a row. The time shown is the
 * LAST occurrence, which is the one you want when asking "is this still going".
 */
export function formatEvent(r: EventRecord): string {
  const d = new Date(r.at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const repeat = r.count && r.count > 1 ? ` (x${r.count})` : '';
  return `${hh}:${mm}  ${r.msg}${repeat}`;
}
