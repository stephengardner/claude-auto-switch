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
  at: number;
  msg: string;
}

export function eventsFilePath(configHome: string): string {
  return path.join(configHome, FILE);
}

/** Read the last `limit` events, oldest first, skipping any malformed lines. */
export function readEvents(configHome: string, limit = 5): EventRecord[] {
  const file = eventsFilePath(configHome);
  if (!existsSync(file)) return [];
  const out: EventRecord[] = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Partial<EventRecord>;
      if (typeof r.at === 'number' && typeof r.msg === 'string') out.push({ at: r.at, msg: r.msg });
    } catch {
      /* skip a malformed line */
    }
  }
  return out.slice(-limit);
}

/** Append one event, keeping only the most recent MAX. */
export function appendEvent(configHome: string, msg: string, now: number): void {
  const records = readEvents(configHome, MAX);
  records.push({ at: now, msg });
  const body = records
    .slice(-MAX)
    .map((r) => JSON.stringify(r))
    .join('\n');
  writeSecretFile(eventsFilePath(configHome), `${body}\n`);
}

/** Format an event as `HH:MM  message` in local time. */
export function formatEvent(r: EventRecord): string {
  const d = new Date(r.at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}  ${r.msg}`;
}
