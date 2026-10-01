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
}

/** A record's field as a string, or '' when it is not one. */
function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

export function liveDesktopConversations(
  c: PathCtx = {},
  isAlive: (pid: number) => boolean = processIsAlive,
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
    found.push({
      pid,
      sessionId,
      cwd,
      name: text(record, 'name'),
      status: text(record, 'status') || 'unknown',
      statusSince: typeof since === 'number' ? since : null,
    });
  }
  // Busy first, since those are the ones spending right now; then the most
  // recently active, which is the one somebody most likely means.
  return found.sort((a, b) => {
    const busy = Number(b.status === 'busy') - Number(a.status === 'busy');
    return busy !== 0 ? busy : (b.statusSince ?? 0) - (a.statusSince ?? 0);
  });
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
