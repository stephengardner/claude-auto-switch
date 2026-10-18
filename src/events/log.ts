import { createHash } from 'node:crypto';
import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync, renameSync, rmSync } from 'node:fs';
import { acquireOwnedLock, withOwnedLockAsync, type LockHandle } from '../claude/locks.js';
import path from 'node:path';
import { writeSecretFile } from '../util/secret-file.js';
import { ccxVersion } from '../util/version.js';

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
/**
 * Held by every append and every compaction, so a compaction never moves the
 * file while a writer has it open. Named for compaction because older builds
 * take it only to compact, and sharing the name keeps them out as well.
 */
const LOCK_SUFFIX = '.compact.lock';
/**
 * A holder lets go within milliseconds. One that has exited is taken over at
 * once, and an older build's, which names no holder, after five seconds. A
 * line is written up to five seconds after it found a running holder, then
 * without the lock rather than dropped.
 */
const LOCK = { waitMs: 5_000, staleMs: 5_000 };
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
  /**
   * Which ccx wrote this line.
   *
   * A log read days later has to say which build produced it, or a report of
   * "it did X" cannot be tied to the code that did X, and a behaviour already
   * fixed reads as still broken. Absent on records written before this existed.
   */
  v?: string;
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
    // Same message from a DIFFERENT build is not the same event: folding them
    // would hide the point where the behaviour changed, which is the one thing
    // the version is recorded to show. A record from before versions existed
    // has nothing to disagree with, so it still folds; refusing there would
    // fill the window with repeats for everyone who upgrades mid-log.
    const sameBuild =
      previous?.v === undefined || record.v === undefined || previous.v === record.v;
    if (previous && previous.msg === record.msg && sameBuild) {
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
        ...(record.v ? { v: record.v } : {}),
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
          ...(typeof r.v === 'string' && r.v.length > 0 ? { v: r.v } : {}),
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
 *
 * Opening the file and writing the line are two steps, though, and a compaction
 * between them would move, archive and delete the file this writer then writes
 * into. So the line is written under the lock every compaction holds.
 *
 * Never waiting for that lock: the thread that asks may be relaying a
 * session's terminal. A line that finds the lock taken is queued, and written
 * once the holder lets go, or past it as LOCK says, on a timer that never keeps
 * the process alive; a process that exits first writes what is queued as it
 * exits (flushQueuedEvents). While a line for a file is queued, later lines
 * for it join the queue, so each process's lines keep their order.
 */
export function appendEvent(
  configHome: string,
  msg: string,
  now: number,
  detail: EventDetail = {},
  // A test passes its own to hold the file open across a compaction, as a
  // writer in another process can between opening the file and writing to it.
  writeLine: (file: string, line: string) => void = appendLine,
): void {
  const file = eventsFilePath(configHome);
  let lock: LockHandle | undefined;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const record = {
      at: now,
      msg,
      v: ccxVersion(),
      ...(detail.kind ? { kind: detail.kind } : {}),
      ...(detail.data ? { data: detail.data } : {}),
    };
    const line = { configHome, file, line: `${JSON.stringify(record)}\n`, writeLine };
    if (queued.some((q) => q.file === file)) {
      enqueue(line);
      return;
    }
    lock = acquireOwnedLock(`${file}${LOCK_SUFFIX}`, { ...LOCK, waitMs: 0 });
    // A lock that cannot be made at all is written past at once: no wait cures it.
    if (!lock.held && lock.unusable === undefined) {
      enqueue(line);
      return;
    }
    writeLine(file, line.line);
  } catch {
    return; // a lost log line must never break a session
  } finally {
    lock?.release();
  }
  trimIfLong(configHome);
}

function appendLine(file: string, line: string): void {
  appendFileSync(file, line, { mode: 0o600 });
}

interface QueuedLine {
  configHome: string;
  file: string;
  line: string;
  writeLine: (file: string, line: string) => void;
}

/** Lines that found the lock taken, oldest first. */
const queued: QueuedLine[] = [];
let draining = false;
let flushesAtExit = false;

function enqueue(line: QueuedLine): void {
  queued.push(line);
  if (!flushesAtExit) {
    flushesAtExit = true;
    process.on('exit', flushQueuedEvents);
  }
  if (!draining) void drain();
}

const UNHELD: LockHandle = { held: false, release: () => {} };

/** Ends in the same step that finds the queue empty, so no line can be left behind it. */
async function drain(): Promise<void> {
  draining = true;
  try {
    for (let next = queued[0]; next !== undefined; next = queued[0]) {
      const file = next.file;
      await withOwnedLockAsync(`${file}${LOCK_SUFFIX}`, LOCK, (lock) => writeQueued(file, lock));
    }
  } catch {
    /* what is still queued goes with the next line, or at exit */
  } finally {
    draining = false;
  }
}

/**
 * Write what is queued, now, blocking for up to LOCK's wait in all, then past
 * the lock. Run at exit, and where a session ends, so that what the session
 * logged is in the file once it returns.
 */
export function flushQueuedEvents(): void {
  const deadline = Date.now() + LOCK.waitMs;
  for (let next = queued[0]; next !== undefined; next = queued[0]) {
    let lock = UNHELD;
    try {
      lock = acquireOwnedLock(`${next.file}${LOCK_SUFFIX}`, { ...LOCK, waitMs: Math.max(0, deadline - Date.now()) });
    } catch {
      /* written past it */
    }
    writeQueued(next.file, lock);
  }
}

/** Write, in order, every line queued for `file`, under `lock` or past it, then let it go. */
function writeQueued(file: string, lock: LockHandle): void {
  let home: string | null = null;
  try {
    for (let i = 0; i < queued.length; ) {
      const q = queued[i] as QueuedLine;
      if (q.file !== file) {
        i += 1;
        continue;
      }
      queued.splice(i, 1);
      home = q.configHome;
      try {
        q.writeLine(q.file, q.line);
      } catch {
        /* a lost log line must never break a session */
      }
    }
  } finally {
    lock.release();
  }
  if (home !== null) trimIfLong(home);
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
 *
 * Exported so a test can compact as another process would, at a chosen moment.
 */
export function trimIfLong(configHome: string): void {
  const file = eventsFilePath(configHome);
  try {
    // The whole point of the cheap path: ask the size, do not read the file.
    if (statSync(file).size <= TRIM_BYTES) return;

    // Never waiting: whoever holds the lock is appending or compacting, and the
    // next append tries again.
    const lock = acquireOwnedLock(`${file}${LOCK_SUFFIX}`, { ...LOCK, waitMs: 0 });
    if (!lock.held) return;
    try {
      if (statSync(file).size <= TRIM_BYTES) return; // they may have just finished

      // Moved aside in one step rather than read and replaced, so a compaction
      // stopped part way leaves every line in a file readers still read. One
      // left that way is archived first, because this rename would replace it.
      const rotating = `${file}${ROTATING_SUFFIX}`;
      if (existsSync(rotating)) archiveRotating(file);
      renameSync(file, rotating);
      archiveRotating(file);
    } finally {
      lock.release();
    }
  } catch {
    /* the file stays long until someone manages it; nothing is lost by that */
  }
}

/**
 * Merge the file parked aside into the archive, keeping the newest records, then
 * remove it.
 *
 * The archive's first line names the parked file it last took in, by a hash of
 * its contents, because a compaction stopped between writing the archive and
 * removing the parked file leaves the same records in both. Merging them again
 * would count them twice and push older ones out. Readers skip the line, as
 * they skip any line that is not an event.
 */
function archiveRotating(file: string): void {
  const rotating = `${file}${ROTATING_SUFFIX}`;
  const archive = `${file}${ARCHIVE_SUFFIX}`;
  const parked = readFileSync(rotating, 'utf8');
  const absorbed = createHash('sha256').update(parked).digest('hex');
  const older = existsSync(archive) ? readFileSync(archive, 'utf8') : '';
  if (absorbedBy(older) !== absorbed) {
    const kept = foldRepeats(parseRecords(joinChunks([older, parked]))).slice(-MAX);
    writeSecretFile(
      archive,
      `${[JSON.stringify({ absorbed }), ...kept.map((r) => JSON.stringify(r))].join('\n')}\n`,
    );
  }
  rmSync(rotating, { force: true });
}

function absorbedBy(archive: string): string | undefined {
  try {
    const first = JSON.parse(archive.split('\n', 1)[0] ?? '') as { absorbed?: unknown };
    return typeof first.absorbed === 'string' ? first.absorbed : undefined;
  } catch {
    return undefined;
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
export function formatEvent(r: EventRecord, previousVersion?: string): string {
  const d = new Date(r.at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const repeat = r.count && r.count > 1 ? ` (x${r.count})` : '';
  // The build is shown when it CHANGES, not on every line. Repeating one
  // version down the whole log is noise; a marker where the build changed is
  // the thing worth seeing, because it says which lines came from which code.
  const version = r.v && r.v !== previousVersion ? `  [ccx ${r.v}]` : '';
  return `${hh}:${mm}  ${r.msg}${repeat}${version}`;
}

/** Format a run of events, marking each point where the build changed. */
export function formatEvents(records: EventRecord[]): string[] {
  let seen: string | undefined;
  return records.map((r) => {
    const line = formatEvent(r, seen);
    if (r.v) seen = r.v;
    return line;
  });
}
