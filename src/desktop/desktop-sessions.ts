import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultClaudeRoot } from '../session/shared-root.js';
import { processIsAlive } from '../session/session-dir.js';
import { looksLikeConversationId } from '../launcher/conversation.js';
import type { PathCtx } from '../config/paths.js';

/**
 * The conversations Claude Desktop has open right now.
 *
 * Desktop runs its Code sessions on the default config folder, and Claude keeps
 * a record per process there, `~/.claude/sessions/<pid>.json`, saying which
 * conversation the process is in, in which folder, under what title, and
 * whether a turn is running. Desktop's are the ones marked
 * `entrypoint: claude-desktop`. Reading them needs nothing from Desktop itself.
 */
export interface DesktopConversation {
  pid: number;
  /** The conversation the process is in now. */
  sessionId: string;
  cwd: string;
  /** Desktop's title for it, empty when it has none. */
  name: string;
  /** `busy` while a turn is running, `idle` once it has stopped; as Claude records it. */
  status: string;
  /** When the status last changed, epoch ms, when recorded. */
  statusSince: number | null;
  /** When the process started, epoch ms, when recorded. */
  startedAt: number | null;
}

/** A record's field as a string, or '' when it is not one. */
function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

export function liveDesktopConversations(
  c: PathCtx = {},
  isAlive: (pid: number) => boolean = isClaudeProcess,
): DesktopConversation[] {
  let dir: string;
  let names: string[];
  try {
    dir = path.join(defaultClaudeRoot(c), 'sessions');
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found: DesktopConversation[] = [];
  for (const file of names) {
    if (!/^\d+\.json$/.test(file)) continue;
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null) continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue; // caught mid-write; the next look sees it
    }
    if (record.entrypoint !== 'claude-desktop') continue;
    const pid = record.pid;
    const sessionId = text(record, 'sessionId');
    const cwd = text(record, 'cwd');
    if (typeof pid !== 'number' || file !== `${pid}.json`) continue;
    if (!looksLikeConversationId(sessionId) || cwd === '') continue;
    // A killed process never deletes its record, and its pid can be reused.
    if (!isAlive(pid)) continue;
    const since = record.statusUpdatedAt;
    const started = record.startedAt;
    found.push({
      pid,
      sessionId,
      cwd,
      name: text(record, 'name'),
      status: text(record, 'status') || 'unknown',
      statusSince: typeof since === 'number' ? since : null,
      startedAt: typeof started === 'number' ? started : null,
    });
  }
  // Newest first, and in an order that does not move: `ccx desktop` numbers
  // the list and `ccx desktop move <n>` reads it again, and an order that
  // followed busy and idle could make the same number mean another
  // conversation by then.
  return found.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.pid - a.pid);
}

/** Claude's process ids, for a few seconds at a time: listing them spawns a program. */
let claudePidCache: { at: number; pids: Set<number> | null } | null = null;
const CLAUDE_PIDS_FRESH_MS = 10_000;

function listClaudePids(platform: NodeJS.Platform): Set<number> | null {
  try {
    if (platform === 'win32') {
      const out = spawnSync('tasklist', ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq claude.exe'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
      });
      if (out.status !== 0 || typeof out.stdout !== 'string') return null;
      const pids = new Set<number>();
      for (const line of out.stdout.split(/\r?\n/)) {
        const pid = /^"[^"]*","(\d+)"/.exec(line)?.[1];
        if (pid) pids.add(Number(pid));
      }
      return pids;
    }
    const out = spawnSync('ps', ['-A', '-o', 'pid=,comm='], { encoding: 'utf8', timeout: 10_000 });
    if (out.status !== 0 || typeof out.stdout !== 'string') return null;
    const pids = new Set<number>();
    for (const line of out.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match && /claude/i.test(path.basename(match[2] as string))) pids.add(Number(match[1]));
    }
    return pids;
  } catch {
    return null;
  }
}

/**
 * Whether `pid` is a live Claude process. A record outlives a process that was
 * killed, and the system hands its pid to the next process soon enough, so a
 * live pid alone does not make a record current: a stale "busy" one would hold
 * a handover back for an hour. When the process list cannot be read, the pid
 * being alive is taken as enough, as before.
 */
export function isClaudeProcess(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  now = Date.now(),
): boolean {
  if (!processIsAlive(pid)) return false;
  if (!claudePidCache || now - claudePidCache.at > CLAUDE_PIDS_FRESH_MS) {
    claudePidCache = { at: now, pids: listClaudePids(platform) };
  }
  return claudePidCache.pids === null || claudePidCache.pids.has(pid);
}

/**
 * Pick one conversation by a number from the list (1-based), a session id, or
 * part of its title. Null when nothing, or more than one title, matches.
 */
export function pickConversation(
  list: DesktopConversation[],
  which: string,
): DesktopConversation | null {
  const wanted = which.trim();
  if (/^\d+$/.test(wanted)) return list[Number(wanted) - 1] ?? null;
  const byId = list.find((c) => c.sessionId === wanted);
  if (byId) return byId;
  const lower = wanted.toLowerCase();
  const byName = list.filter((c) => c.name.toLowerCase().includes(lower));
  return byName.length === 1 ? (byName[0] as DesktopConversation) : null;
}

/** How a message names a conversation: its title, or its id when it has none yet. */
export function called(conv: { name: string; sessionId: string }): string {
  return conv.name ? `"${conv.name}"` : `conversation ${conv.sessionId.slice(0, 8)}`;
}
