import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Whether a turn was refused, from the conversation's own record rather than
 * from what is on the screen.
 *
 * The screen of a session working ON limits (code, logs, a conversation about
 * them) is full of limit-shaped words, and matching them restarted healthy
 * sessions every few minutes. Claude's record of the conversation says it
 * outright: a refused turn is written as an answer flagged `isApiErrorMessage`,
 * with Claude's code for the failure in `error` ("rate_limit" for a usage
 * limit, "billing_error" for credits), the API's own code in `apiError`, and the
 * HTTP status in `apiErrorStatus` (429). Measured on Claude 2.1.280 and 2.1.284.
 *
 * A subagent's refused turn is written the same way, flagged `isSidechain`, in
 * a record of the subagent's own: `<id>/subagents/agent-<agent>.jsonl` beside
 * the conversation's `<id>.jsonl`, and one folder deeper for the agents a
 * workflow starts. Measured on 2.1.296, where the conversation's own record
 * holds no subagent entries at all; older versions wrote them into it.
 */

/** A turn the record says was refused because the account, or a model on it, is out. */
export interface Refusal {
  /** Claude's code: "rate_limit" or "billing_error". */
  error: string;
  /** The API's code when there is one, e.g. "model_requires_usage_credits". */
  apiError: string | null;
  status: number | null;
  /** What Claude showed for it, for the checks that read the wording. */
  text: string;
  /**
   * A subagent met it, not the main thread. The account is the same one, but
   * the main thread has not stopped: it may be waiting on that subagent, or
   * working, and it meets the limit itself only at its own next request.
   */
  sidechain: boolean;
}

/** The refusal in one record entry, or null when the entry is anything else. */
export function refusalIn(entry: unknown): Refusal | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as {
    type?: unknown;
    isSidechain?: unknown;
    isApiErrorMessage?: unknown;
    error?: unknown;
    apiError?: unknown;
    apiErrorStatus?: unknown;
    message?: { content?: unknown };
  };
  if (e.type !== 'assistant' || e.isApiErrorMessage !== true) return null;
  const error = typeof e.error === 'string' ? e.error : '';
  const status = typeof e.apiErrorStatus === 'number' ? e.apiErrorStatus : null;
  if (error !== 'rate_limit' && error !== 'billing_error' && status !== 429) return null;
  const content = Array.isArray(e.message?.content) ? (e.message.content as unknown[]) : [];
  const text = content
    .map((c) =>
      typeof (c as { text?: unknown })?.text === 'string' ? (c as { text: string }).text : '',
    )
    .filter(Boolean)
    .join('\n');
  return {
    error: error || 'rate_limit',
    apiError: typeof e.apiError === 'string' ? e.apiError : null,
    status,
    text,
    sidechain: e.isSidechain === true,
  };
}

/**
 * When a prompt somebody typed at Claude's terminal was recorded, or null when
 * the entry is anything else: a tool result, a notice from a background task,
 * a subagent's prompt. Claude 2.1.296 marks the typed ones `origin.kind:
 * "human"` (measured, for a prompt typed into its pseudo-terminal).
 */
function promptAtIn(entry: unknown): number | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as {
    type?: unknown;
    isSidechain?: unknown;
    origin?: unknown;
    timestamp?: unknown;
  };
  if (e.type !== 'user' || e.isSidechain === true) return null;
  if ((e.origin as { kind?: unknown } | null | undefined)?.kind !== 'human') return null;
  const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
  return Number.isFinite(at) ? at : null;
}

/** Conversation `id`'s record under a Claude config folder, or null when there is none yet. */
export function findTranscript(configDir: string, id: string): string | null {
  const projects = path.join(configDir, 'projects');
  let folders: string[];
  try {
    folders = readdirSync(projects);
  } catch {
    return null;
  }
  for (const folder of folders) {
    const file = path.join(projects, folder, `${id}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * Every subagent record under a conversation's `subagents` folder: the
 * `agent-<id>.jsonl` files in it, and those in the folders below it, two deep
 * at most (`workflows/<run>/`). A workflow keeps other files there too, such
 * as its `journal.jsonl` of results, which are not any subagent's record.
 */
function subagentRecords(dir: string, deeper = 2): string[] {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // no subagent has run yet
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (deeper > 0) files.push(...subagentRecords(full, deeper - 1));
    } else if (entry.name.startsWith('agent-') && entry.name.endsWith('.jsonl')) {
      files.push(full);
    }
  }
  return files;
}

function readRange(file: string, from: number, to: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(to - from);
    const read = readSync(fd, buffer, 0, to - from, from);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** One record being read as it grows. */
interface Tail {
  file: string;
  offset: number;
  /** Bytes after the last complete line: a line is only read once it is whole. */
  rest: Buffer;
}

const tailOf = (file: string, offset: number): Tail => ({ file, offset, rest: Buffer.alloc(0) });

function sizeOf(file: string): number | null {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

/** The whole lines a record gained since it was last read; null when it cannot be read. */
function newLines(tail: Tail): string[] | null {
  const size = sizeOf(tail.file);
  if (size === null) return null;
  if (size < tail.offset) {
    // Rewritten from scratch: read it again from the top.
    tail.offset = 0;
    tail.rest = Buffer.alloc(0);
  }
  if (size === tail.offset) return [];
  let chunk: Buffer;
  try {
    chunk = readRange(tail.file, tail.offset, size);
  } catch {
    return null;
  }
  tail.offset += chunk.length;
  const bytes = Buffer.concat([tail.rest, chunk]);
  // Split on the last newline BYTE, so a character cut in two by the read
  // is never decoded half here and half next time.
  const end = bytes.lastIndexOf(0x0a);
  if (end === -1) {
    tail.rest = bytes;
    return [];
  }
  tail.rest = bytes.subarray(end + 1);
  return bytes.subarray(0, end).toString('utf8').split('\n');
}

function parsed(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null; // not a whole entry
  }
}

/** What a conversation's record, and its subagents' records, gained since the last look. */
export interface RecordNews {
  /** Whether the conversation's record could be read at all. */
  readable: boolean;
  /** The refused turns, each once: the main thread's and its subagents'. */
  refusals: Refusal[];
  /**
   * When the newest prompt somebody typed was recorded, among what was just
   * read; null when none was. Claude's clock, in milliseconds.
   */
  promptAt: number | null;
  /**
   * Whether any subagent's record grew since the last look. A subagent that
   * is writing is running, whatever else can or cannot be known about it.
   */
  subagentsWrote: boolean;
}

export interface RefusalFollower {
  /**
   * Read what the record of conversation `id` gained since the last call.
   * `readable` says whether the record could be read at all; until it can,
   * nothing here can say anything.
   *
   * A record that already exists when it is first seen is read from its END:
   * its past is not news, and a resumed conversation's old refusals must not
   * move a session that is working. One that appears later is read whole. The
   * same holds for each subagent's record.
   */
  poll(id: string | null): RecordNews;
}

/**
 * `firstFromStart`: read the FIRST conversation's record whole even when it
 * already exists, for a launch that starts a new conversation: everything in
 * it is this launch's, and a refusal written before the first look must not be
 * skipped. A launch that resumes one leaves it false, so its history is not news.
 */
export function createRefusalFollower(configDir: string, firstFromStart = false): RefusalFollower {
  let following: string | null = null;
  let first = true;
  let main: Tail | null = null;
  /** Each subagent's record, by its file. */
  let subagents = new Map<string, Tail>();
  const none = (readable: boolean): RecordNews => ({
    readable,
    refusals: [],
    promptAt: null,
    subagentsWrote: false,
  });
  const subagentsDir = (record: string, id: string): string =>
    path.join(path.dirname(record), id, 'subagents');

  return {
    poll(id) {
      if (!id) return none(false);
      if (id !== following) {
        following = id;
        subagents = new Map();
        const file = findTranscript(configDir, id);
        const fromStart = first && firstFromStart;
        first = false;
        const size = file ? sizeOf(file) : null;
        main = file !== null && size !== null ? tailOf(file, fromStart ? 0 : size) : null;
        if (!fromStart) {
          // The subagents this conversation has had so far are its past too.
          if (main) {
            for (const record of subagentRecords(subagentsDir(main.file, id))) {
              subagents.set(record, tailOf(record, sizeOf(record) ?? 0));
            }
          }
          return none(main !== null);
        }
      }
      if (!main) {
        const file = findTranscript(configDir, id);
        if (!file) return none(false);
        main = tailOf(file, 0);
      }
      const lines = newLines(main);
      if (lines === null) return none(false);

      const refusals: Refusal[] = [];
      let promptAt: number | null = null;
      let subagentsWrote = false;
      for (const line of lines) {
        if (line.includes('"isApiErrorMessage":true')) {
          const refusal = refusalIn(parsed(line));
          if (refusal) refusals.push(refusal);
        } else if (line.includes('"kind":"human"')) {
          const at = promptAtIn(parsed(line));
          if (at !== null && (promptAt === null || at > promptAt)) promptAt = at;
        }
      }
      for (const record of subagentRecords(subagentsDir(main.file, id))) {
        let tail = subagents.get(record);
        if (!tail) {
          // Started since the last look: all of it is news.
          tail = tailOf(record, 0);
          subagents.set(record, tail);
        }
        const readTo = tail.offset;
        const lines = newLines(tail) ?? [];
        if (tail.offset !== readTo) subagentsWrote = true;
        for (const line of lines) {
          if (!line.includes('"isApiErrorMessage":true')) continue;
          const refusal = refusalIn(parsed(line));
          // The file is a subagent's, whatever the entry says of itself.
          if (refusal) refusals.push({ ...refusal, sidechain: true });
        }
      }
      return { readable: true, refusals, promptAt, subagentsWrote };
    },
  };
}
