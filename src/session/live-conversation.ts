import { readFileSync } from 'node:fs';
import path from 'node:path';
import { looksLikeConversationId } from '../launcher/conversation.js';

/**
 * Which conversation a running Claude is in, in Claude's own words.
 *
 * A swap ends the child and resumes its conversation in a new one, so ccx has
 * to know which conversation that is. What it knew before was second-hand: the
 * id it chose at launch, which goes stale the moment the operator runs `/clear`
 * or `/resume`, and whatever the status line last reported, which only happens
 * when ccx's own status line is the one Claude runs. Without either, a swap
 * fell back to "the most recent conversation in this folder", which is a
 * different thread whenever two sessions share a project, and two processes
 * then wrote into one conversation.
 *
 * Claude keeps a record per process at `<config dir>/sessions/<pid>.json` and
 * rewrites its `sessionId` on every switch: a resume, a pick from the picker,
 * `/clear`. Measured against the real binary (2.1.280 and 2.1.284), in a
 * throwaway config folder: a resume records the resumed id from the first
 * write, with no placeholder before it; a fork records the id given to
 * `--session-id`; the picker records a placeholder until something is picked,
 * then the pick; `/clear` switches it to the new conversation. Claude deletes
 * the record when it exits, so it has to be read while the child is alive.
 *
 * `spawnedAt` is when this child was started. A record is named only by pid,
 * and a killed Claude never gets to delete its own, so until this child writes
 * its first record the file there can be a dead one's that happens to share the
 * pid. Claude stamps each record with when it was written, so anything older
 * than this child is not about this child.
 */
export function readLiveConversation(configDir: string, pid: number, spawnedAt = 0): string | null {
  try {
    const record = JSON.parse(readFileSync(path.join(configDir, 'sessions', `${pid}.json`), 'utf8')) as unknown;
    if (typeof record !== 'object' || record === null) return null;
    const { pid: recordedPid, sessionId, startedAt } = record as {
      pid?: unknown;
      sessionId?: unknown;
      startedAt?: unknown;
    };
    if (recordedPid !== pid) return null;
    // A second of slack for clock granularity; a dead process's record is
    // minutes or hours older than this.
    if (typeof startedAt !== 'number' || startedAt < spawnedAt - 1000) return null;
    return typeof sessionId === 'string' && looksLikeConversationId(sessionId) ? sessionId : null;
  } catch {
    // Not written yet, gone already, or caught mid-write: nothing to learn this
    // time, and the next read will see it.
    return null;
  }
}

/** What Claude says it is doing, and for how long it has said so. */
export interface LiveStatus {
  status: string;
  forMs: number;
}

/**
 * What the Claude process `pid` says it is doing, from the same record. Read
 * from the 2.1.296 binary and measured against it:
 *
 * - "idle": at its prompt, no dialog open, nothing running.
 * - "shell": the same, while a background shell command runs.
 * - "busy": a turn is running, or a subagent, teammate or workflow is.
 * - "waiting": a dialog is open (a permission request, a picker, the choice
 *   Claude offers on some limits); `waitingFor` says which kind.
 *
 * Null when the record cannot be read or carries no status (Claude writes the
 * record about a second before it first adds one), so a caller only ever acts
 * on what Claude definitely said.
 */
export function readLiveStatus(
  configDir: string,
  pid: number,
  spawnedAt = 0,
  now = Date.now(),
): LiveStatus | null {
  try {
    const record = JSON.parse(readFileSync(path.join(configDir, 'sessions', `${pid}.json`), 'utf8')) as unknown;
    if (typeof record !== 'object' || record === null) return null;
    const { pid: recordedPid, startedAt, status, statusUpdatedAt } = record as {
      pid?: unknown;
      startedAt?: unknown;
      status?: unknown;
      statusUpdatedAt?: unknown;
    };
    if (recordedPid !== pid) return null;
    if (typeof startedAt !== 'number' || startedAt < spawnedAt - 1000) return null;
    if (typeof status !== 'string' || typeof statusUpdatedAt !== 'number') return null;
    return { status, forMs: Math.max(0, now - statusUpdatedAt) };
  } catch {
    return null;
  }
}

/**
 * How long the Claude process `pid` has been idle with nothing running at
 * all. Null in every other state, so a caller that ends Claude on this never
 * ends a turn, a subagent or a background command with it.
 */
export function idleForMs(configDir: string, pid: number, spawnedAt = 0, now = Date.now()): number | null {
  const live = readLiveStatus(configDir, pid, spawnedAt, now);
  return live?.status === 'idle' ? live.forMs : null;
}
