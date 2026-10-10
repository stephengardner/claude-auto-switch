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
  /** When Claude recorded it, by Claude's clock in milliseconds; null when the entry does not say. */
  at: number | null;
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
    timestamp?: unknown;
    message?: { content?: unknown };
  };
  // A subagent's refusal is the same account's, and the main thread meets it
  // next; counting both would make one refusal look like two.
  if (e.type !== 'assistant' || e.isApiErrorMessage !== true || e.isSidechain === true) return null;
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
  const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
  return {
    error: error || 'rate_limit',
    apiError: typeof e.apiError === 'string' ? e.apiError : null,
    status,
    text,
    at: Number.isFinite(at) ? at : null,
  };
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

export interface RefusalFollower {
  /**
   * Read what the record of conversation `id` gained since the last call and
   * return the refusals in it, each once. `readable` says whether the record
   * could be read at all; until it can, nothing here can say anything.
   *
   * A record that already exists when it is first seen is read from its END:
   * its past is not news, and a resumed conversation's old refusals must not
   * move a session that is working. One that appears later is read whole.
   */
  poll(id: string | null): { readable: boolean; refusals: Refusal[] };
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
  let file: string | null = null;
  let offset = 0;
  /** Bytes after the last complete line: a line is only read once it is whole. */
  let rest: Buffer = Buffer.alloc(0);
  const none = (readable: boolean): { readable: boolean; refusals: Refusal[] } => ({
    readable,
    refusals: [],
  });

  return {
    poll(id) {
      if (!id) return none(false);
      if (id !== following) {
        following = id;
        file = findTranscript(configDir, id);
        rest = Buffer.alloc(0);
        const fromStart = first && firstFromStart;
        first = false;
        try {
          offset = file && !fromStart ? statSync(file).size : 0;
        } catch {
          file = null;
          offset = 0;
        }
        if (!fromStart) return none(file !== null);
      }
      if (!file) {
        file = findTranscript(configDir, id);
        if (!file) return none(false);
        offset = 0;
        rest = Buffer.alloc(0);
      }
      let size: number;
      try {
        size = statSync(file).size;
      } catch {
        return none(false);
      }
      if (size < offset) {
        // Rewritten from scratch: read it again from the top.
        offset = 0;
        rest = Buffer.alloc(0);
      }
      if (size === offset) return none(true);
      let chunk: Buffer;
      try {
        chunk = readRange(file, offset, size);
      } catch {
        return none(false);
      }
      offset += chunk.length;
      const bytes = Buffer.concat([rest, chunk]);
      // Split on the last newline BYTE, so a character cut in two by the read
      // is never decoded half here and half next time.
      const end = bytes.lastIndexOf(0x0a);
      if (end === -1) {
        rest = bytes;
        return none(true);
      }
      rest = bytes.subarray(end + 1);
      const refusals: Refusal[] = [];
      for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.includes('"isApiErrorMessage":true')) continue;
        try {
          const refusal = refusalIn(JSON.parse(line));
          if (refusal) refusals.push(refusal);
        } catch {
          /* not a whole entry */
        }
      }
      return { readable: true, refusals };
    },
  };
}
