import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../util/atomic-write.js';

/**
 * How the Artifact hook and the ccx process that owns a session talk: files in
 * the session's own folder, which only that session's Claude and its ccx read,
 * and which goes when the session does.
 *
 * The hook asks for the session to be on another account for one call
 * (`<id>.ask.json`), and says when the call is over (`<id>.done`). The ccx
 * process answers, and later says how the move ended (`<id>.hop.json`). The
 * hook never moves a login itself, and the move ends by the ccx process's own
 * clock whether or not the hook is heard from again. `<id>` is the tool
 * call's own id, so two calls can never be taken for one.
 */

/** Written by a ccx that answers these requests. A hook that finds none is in a session of an older ccx. */
const READY = 'ready.json';
export const HOP_PROTOCOL = 1;

export interface HopAsk {
  id: string;
  /** The account the call must go out as. */
  to: string;
  at: number;
  /** The conversation's record and how long it was when the call began, to see the call's result arrive in. */
  transcript: string | null;
  transcriptFrom: number | null;
}

/** How a held move ended. */
export type HopEnd =
  /** The hook said the call was over. */
  | 'done'
  /** The call's result appeared in the conversation's record. */
  | 'result'
  /** Nothing said it was over, and its time ran out. */
  | 'deadline'
  /** Claude itself ended. */
  | 'child-exit';

export type HopState =
  /** The session is on `to`, and stays until the call is over. `moved` is false when it was there already. */
  | { id: string; state: 'applied'; to: string; from: string; at: number; moved: boolean }
  /** The session was not moved, and why, in words for whoever made the call. */
  | { id: string; state: 'refused'; to: string; reason: string; at: number }
  /** The session is back on `from`. `at` is when the move was applied. */
  | { id: string; state: 'ended'; to: string; from: string; at: number; endedAt: number; by: HopEnd };

export function hopDir(sessionDir: string): string {
  return path.join(sessionDir, 'artifact-hops');
}

/** A tool call's id as a file name: its own letters, digits, dashes and underscores. */
export function hopId(toolUseId: unknown): string | null {
  if (typeof toolUseId !== 'string') return null;
  const safe = toolUseId.replace(/[^A-Za-z0-9_-]/g, '');
  return safe.length > 0 && safe.length <= 128 ? safe : null;
}

const askFile = (dir: string, id: string): string => path.join(hopDir(dir), `${id}.ask.json`);
const stateFile = (dir: string, id: string): string => path.join(hopDir(dir), `${id}.hop.json`);
const doneFile = (dir: string, id: string): string => path.join(hopDir(dir), `${id}.done`);

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null; // missing, or caught between two writes
  }
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(data));
}

/** Say that this session's ccx answers requests. Clears what an earlier run left. */
export function openHops(sessionDir: string, pid: number): void {
  try {
    rmSync(hopDir(sessionDir), { recursive: true, force: true });
    writeJson(path.join(hopDir(sessionDir), READY), { v: HOP_PROTOCOL, pid });
  } catch {
    /* without it the hook refuses routed calls, which is the safe side */
  }
}

/** Whether a ccx that answers requests owns this session. */
export function hopsOpen(sessionDir: string): boolean {
  return readJson(path.join(hopDir(sessionDir), READY))?.v === HOP_PROTOCOL;
}

export function writeAsk(sessionDir: string, ask: HopAsk): void {
  writeJson(askFile(sessionDir, ask.id), ask);
}

/** The requests waiting, the oldest first. */
export function readAsks(sessionDir: string): HopAsk[] {
  let names: string[];
  try {
    names = readdirSync(hopDir(sessionDir));
  } catch {
    return [];
  }
  const asks: HopAsk[] = [];
  for (const name of names) {
    if (!name.endsWith('.ask.json')) continue;
    const raw = readJson(path.join(hopDir(sessionDir), name));
    const id = hopId(raw?.id);
    if (!raw || id === null || `${id}.ask.json` !== name) continue;
    if (typeof raw.to !== 'string' || raw.to.length === 0 || typeof raw.at !== 'number') continue;
    asks.push({
      id,
      to: raw.to,
      at: raw.at,
      transcript: typeof raw.transcript === 'string' && raw.transcript.length > 0 ? raw.transcript : null,
      transcriptFrom: typeof raw.transcriptFrom === 'number' && raw.transcriptFrom >= 0 ? raw.transcriptFrom : null,
    });
  }
  return asks.sort((a, b) => a.at - b.at);
}

export function removeAsk(sessionDir: string, id: string): void {
  rmSync(askFile(sessionDir, id), { force: true });
}

export function writeState(sessionDir: string, state: HopState): void {
  writeJson(stateFile(sessionDir, state.id), state);
}

export function readState(sessionDir: string, id: string): HopState | null {
  const raw = readJson(stateFile(sessionDir, id));
  if (!raw || raw.id !== id || typeof raw.to !== 'string' || typeof raw.at !== 'number') return null;
  if (raw.state === 'refused') {
    return typeof raw.reason === 'string' ? { id, state: 'refused', to: raw.to, reason: raw.reason, at: raw.at } : null;
  }
  if (typeof raw.from !== 'string') return null;
  if (raw.state === 'applied') {
    return { id, state: 'applied', to: raw.to, from: raw.from, at: raw.at, moved: raw.moved !== false };
  }
  if (raw.state === 'ended' && typeof raw.endedAt === 'number') {
    const by = raw.by === 'done' || raw.by === 'result' || raw.by === 'child-exit' ? raw.by : 'deadline';
    return { id, state: 'ended', to: raw.to, from: raw.from, at: raw.at, endedAt: raw.endedAt, by };
  }
  return null;
}

/** The call is over (or was never made): the session can go back. */
export function markDone(sessionDir: string, id: string): void {
  try {
    mkdirSync(hopDir(sessionDir), { recursive: true });
    writeFileSync(doneFile(sessionDir, id), '', 'utf8');
  } catch {
    /* the move still ends by its own clock */
  }
}

export function isDone(sessionDir: string, id: string): boolean {
  try {
    return statSync(doneFile(sessionDir, id)).isFile();
  } catch {
    return false;
  }
}

/** Forget a call's request and its done mark. Its answer stays for the hook that reads it after the call. */
export function clearCall(sessionDir: string, id: string): void {
  for (const file of [askFile(sessionDir, id), doneFile(sessionDir, id)]) {
    try {
      rmSync(file, { force: true });
    } catch {
      /* swept with the folder */
    }
  }
}

/**
 * Whether the session was away at any time since `since`: a move still held,
 * or one that ended at or after it. `except` leaves one call's own move out.
 */
export function awaySince(sessionDir: string, since: number, except: string | null = null): boolean {
  let names: string[];
  try {
    names = readdirSync(hopDir(sessionDir));
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith('.hop.json')) continue;
    const id = name.slice(0, -'.hop.json'.length);
    if (id === except) continue;
    const state = readState(sessionDir, id);
    if (state?.state === 'applied' && state.moved) return true;
    if (state?.state === 'ended' && state.endedAt >= since) return true;
  }
  return false;
}

/** Remove answers and marks nothing will read again: those older than `maxAgeMs`. */
export function sweepHops(sessionDir: string, now: number, maxAgeMs: number): void {
  let names: string[];
  try {
    names = readdirSync(hopDir(sessionDir));
  } catch {
    return;
  }
  for (const name of names) {
    if (name === READY || name.endsWith('.ask.json')) continue;
    const file = path.join(hopDir(sessionDir), name);
    try {
      if (now - statSync(file).mtimeMs > maxAgeMs) rmSync(file, { force: true });
    } catch {
      /* gone already */
    }
  }
}
