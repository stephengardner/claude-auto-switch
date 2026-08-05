import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { writeSecretFile } from '../util/secret-file.js';

/**
 * A tiny append-only event log shared between processes: `ccx run` writes swap
 * events here, and the dashboard (a separate process) tails it so you can watch
 * swaps happen live. Bounded so it never grows without limit; owner-only.
 */
const FILE = 'events.jsonl';
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
  if (!existsSync(file)) return [];
  try {
    return foldRepeats(parseRecords(readFileSync(file, 'utf8'))).slice(-limit);
  } catch {
    return []; // an unreadable log is not worth failing a command over
  }
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
const TRIM_BYTES = 64 * 1024;

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
export function appendEvent(configHome: string, msg: string, now: number): void {
  const file = eventsFilePath(configHome);
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify({ at: now, msg })}\n`, { mode: 0o600 });
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

    const kept = foldRepeats(parseRecords(readFileSync(file, 'utf8'))).slice(-MAX);
    writeSecretFile(file, `${kept.map((r) => JSON.stringify(r)).join('\n')}\n`);
  } catch {
    /* the file stays long until someone manages it; nothing is lost by that */
  }
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
