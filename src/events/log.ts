import { existsSync, readFileSync } from 'node:fs';
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
      out[out.length - 1] = {
        at: record.at,
        msg: record.msg,
        count: (previous.count ?? 1) + (record.count ?? 1),
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
  const out: EventRecord[] = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
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
  return foldRepeats(out).slice(-limit);
}

/**
 * Append one event, keeping only the most recent MAX.
 *
 * A message identical to the one before it COLLAPSES into that record, bumping
 * a count and the time rather than adding a line. This log is bounded, so
 * without it a caller stuck in a loop empties the window of everything else:
 * that has happened twice, once filling all 200 entries with a single line, and
 * both times it blinded `ccx dashboard` and `ccx history` exactly when they were
 * the tools being reached for. Collapsing keeps the information that something
 * is repeating, and the count says how much.
 */
export function appendEvent(configHome: string, msg: string, now: number): void {
  const records = readEvents(configHome, MAX);
  const previous = records[records.length - 1];
  if (previous && previous.msg === msg) {
    records[records.length - 1] = { at: now, msg, count: (previous.count ?? 1) + 1 };
  } else {
    records.push({ at: now, msg });
  }
  const body = records
    .slice(-MAX)
    .map((r) => JSON.stringify(r))
    .join('\n');
  writeSecretFile(eventsFilePath(configHome), `${body}\n`);
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
