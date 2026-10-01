import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  liveDesktopConversations,
  pickConversation,
  type DesktopConversation,
} from './desktop-sessions.js';
import type { PathCtx } from '../config/paths.js';

const A = '11111111-2222-4333-8444-555555555555';
const B = '22222222-3333-4444-8555-666666666666';
const C = '33333333-4444-4555-8666-777777777777';

/** A home whose ~/.claude/sessions holds these records, as Claude writes them. */
function home(records: Record<string, unknown>[]): PathCtx {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-desk-sess-'));
  const sessions = path.join(dir, '.claude', 'sessions');
  mkdirSync(sessions, { recursive: true });
  for (const r of records)
    writeFileSync(path.join(sessions, `${String(r.pid)}.json`), JSON.stringify(r), 'utf8');
  return { env: { HOME: dir, USERPROFILE: dir } };
}

const desktop = (
  pid: number,
  sessionId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  pid,
  sessionId,
  cwd: `C:\\work\\${pid}`,
  entrypoint: 'claude-desktop',
  kind: 'interactive',
  ...extra,
});

describe("Claude Desktop's open conversations", () => {
  it('reads them from the records Claude keeps, Desktop ones only', () => {
    const ctx = home([
      desktop(100, A, { name: 'Schema review', status: 'idle', statusUpdatedAt: 5, startedAt: 2 }),
      { pid: 200, sessionId: B, cwd: 'C:\\x', entrypoint: 'cli' }, // a terminal session
    ]);
    const found = liveDesktopConversations(ctx, () => true);
    expect(found).toEqual([
      {
        pid: 100,
        sessionId: A,
        cwd: 'C:\\work\\100',
        name: 'Schema review',
        status: 'idle',
        statusSince: 5,
        startedAt: 2,
      },
    ]);
  });

  it('skips a dead process, a record under the wrong name, and anything unusable', () => {
    const ctx = home([desktop(100, A), desktop(101, 'not-an-id'), desktop(102, C, { cwd: '' })]);
    // Written under 103.json but claiming pid 104: not the record of the process it is named for.
    writeFileSync(
      path.join(ctx.env!.HOME as string, '.claude', 'sessions', '103.json'),
      JSON.stringify(desktop(104, B)),
      'utf8',
    );
    expect(liveDesktopConversations(ctx, (pid) => pid !== 100)).toEqual([]);
  });

  it('lists the newest first, in an order a turn starting or stopping does not move', () => {
    const records = [
      desktop(1, A, { status: 'idle', statusUpdatedAt: 300, startedAt: 10 }),
      desktop(2, B, { status: 'busy', statusUpdatedAt: 100, startedAt: 30 }),
      desktop(3, C, { status: 'idle', statusUpdatedAt: 900, startedAt: 20 }),
    ];
    expect(liveDesktopConversations(home(records), () => true).map((c) => c.pid)).toEqual([
      2, 3, 1,
    ]);
    // Conversation 1 starts a turn: "ccx desktop move 3" must still mean it.
    const busier = records.map((r) =>
      r.pid === 1 ? { ...r, status: 'busy', statusUpdatedAt: 999 } : r,
    );
    expect(liveDesktopConversations(home(busier), () => true).map((c) => c.pid)).toEqual([2, 3, 1]);
  });

  it('is empty when Claude has never run here', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-desk-none-'));
    expect(liveDesktopConversations({ env: { HOME: dir, USERPROFILE: dir } })).toEqual([]);
  });
});

describe('picking one', () => {
  const list: DesktopConversation[] = [
    {
      pid: 1,
      sessionId: A,
      cwd: 'x',
      name: 'Database schema review',
      status: 'busy',
      statusSince: null,
      startedAt: null,
    },
    {
      pid: 2,
      sessionId: B,
      cwd: 'y',
      name: 'react-ifying the builder',
      status: 'idle',
      statusSince: null,
      startedAt: null,
    },
    {
      pid: 3,
      sessionId: C,
      cwd: 'z',
      name: 'Database schema review (fork)',
      status: 'idle',
      statusSince: null,
      startedAt: null,
    },
  ];

  it('by its number in the list, its id, or a piece of its title', () => {
    expect(pickConversation(list, '2')?.pid).toBe(2);
    expect(pickConversation(list, C)?.pid).toBe(3);
    expect(pickConversation(list, 'REACT')?.pid).toBe(2);
  });

  it('refuses rather than guesses when a title piece matches more than one', () => {
    expect(pickConversation(list, 'database')).toBeNull();
    expect(pickConversation(list, '9')).toBeNull();
  });
});
