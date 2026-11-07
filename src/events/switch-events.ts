import { AccountSchema } from '../accounts/registry.schema.js';
import { readEventRecords, type EventDetail, type EventRecord } from './log.js';

/**
 * The account moves in ccx's event log, as values: what happened, between
 * which accounts, and why, for `ccx history --json`.
 *
 * Only a record's `kind` and `data` are read, never its `msg`, which is a
 * sentence for a person and may be reworded at any release. So a move written
 * without them is not one of these, rather than a guess at its words: before
 * 2.6.33 a move made on request, a session start and a requested switch were
 * written as words alone, and an account running out did not name the account.
 * Moves made when an account ran out, failed and waiting moves, and the
 * editor's moves were already written with their accounts, so those reach
 * back as far as the log does.
 */

export type SwitchEventKind =
  /** A session moved to another account in place, without a restart. */
  | 'moved'
  /** A move was tried and the session stayed on its account. */
  | 'move-failed'
  /** A move is waiting for the session's Claude to let go of its login, and happens then. */
  | 'move-waiting'
  /** A move was asked for (`ccx swap`, `ccx auto`); the session makes it at its next look. */
  | 'move-asked'
  /** The editor's folder moved to another account. */
  | 'editor-moved'
  /** An account ran out: what starts a move. */
  | 'ran-out'
  /** A session started on an account, or carried on there after a restart. */
  | 'started';

export type SwitchReason =
  /** The account ran out of room: a usage window, or a model's own. */
  | 'capacity'
  /** Asked for: `ccx use`, `ccx swap`, the dashboard. */
  | 'asked'
  /** Moved before running out (rotation.proactivePercent, `ccx auto`). */
  | 'proactive'
  /** The editor's folder followed the account new sessions start on. */
  | 'follows-active'
  /** A session started on it. */
  | 'session-start'
  /** A session carried on there after a restart. */
  | 'continued'
  /** A record whose reason this version does not know. */
  | 'unknown';

export interface SwitchEvent {
  /** When it happened: the last time, when it repeated. */
  at: number;
  kind: SwitchEventKind;
  /** The account it left; null when there was none or the record does not say. */
  from: string | null;
  /** The account it went to; null when it went to none. */
  to: string | null;
  reason: SwitchReason;
  /** How many times in a row it happened, when more than once. */
  count?: number;
  /** The ccx that wrote it, when the record says. */
  v?: string;
}

/** Why a move was asked for or made, as its writer records it in `data.reason`. */
export type RecordedSwitchReason = 'asked' | 'proactive';

/** Reasons a writer may record in its own `data.reason`. */
const RECORDED_REASONS: ReadonlySet<SwitchReason> = new Set<RecordedSwitchReason>([
  'asked',
  'proactive',
]);

/**
 * What a writer records with a move, built here so the kind and the fields
 * are spelled once, beside the reader that turns them back into moves
 * (toSwitchEvent). A record built any other way is one this file has to guess.
 */
export const switchDetail = {
  /** A session moved in place to `to`, because it was asked to. */
  moved: (
    from: string | null,
    to: string,
    reason: RecordedSwitchReason,
    extra: Record<string, unknown> = {},
  ): EventDetail => ({
    kind: 'switch',
    data: { from, to, reason, ...extra },
  }),
  /** A move to `to` was asked for; the session makes it at its next look. */
  asked: (
    from: string | null,
    to: string,
    reason: RecordedSwitchReason,
    extra: Record<string, unknown> = {},
  ): EventDetail => ({
    kind: 'switch-request',
    data: { from, to, reason, ...extra },
  }),
  /** A move to `to` was tried and the session stayed on `from`. */
  failed: (from: string | null, to: string, reason: RecordedSwitchReason): EventDetail => ({
    kind: 'move-failed',
    data: { from, to, reason },
  }),
  /** A move to `to` waits for the session's Claude to let go of its login. */
  waiting: (from: string | null, to: string, reason: RecordedSwitchReason): EventDetail => ({
    kind: 'move-pending',
    data: { from, to, reason },
  }),
  /** A session started on `account`, or carried on there after a restart. */
  sessionStart: (account: string, continued: boolean): EventDetail => ({
    kind: 'session-start',
    data: { account, continued },
  }),
};

/** An account name by the registry's own rule, or null for anything else (a folder path, say). */
function accountName(value: unknown): string | null {
  return typeof value === 'string' && AccountSchema.shape.name.safeParse(value).success
    ? value
    : null;
}

function recordedReason(value: unknown): SwitchReason {
  return RECORDED_REASONS.has(value as SwitchReason) ? (value as SwitchReason) : 'unknown';
}

/**
 * The reason a failed or waiting move records, or, for one written before it
 * recorded any (2.6.32 and older), `asked`: only a move asked for could fail
 * or wait then.
 */
function moveReason(value: unknown): SwitchReason {
  return value === undefined ? 'asked' : recordedReason(value);
}

/** The move one record describes, or null when it describes none. */
export function toSwitchEvent(record: EventRecord): SwitchEvent | null {
  const data = record.data ?? {};
  const from = accountName(data.from);
  const to = accountName(data.to);
  const event = (
    kind: SwitchEventKind,
    reason: SwitchReason,
    left: string | null,
    went: string | null,
  ): SwitchEvent => ({
    at: record.at,
    kind,
    from: left,
    to: went,
    reason,
    ...(record.count !== undefined && record.count > 1 ? { count: record.count } : {}),
    ...(record.v !== undefined ? { v: record.v } : {}),
  });
  switch (record.kind) {
    case 'cap-relief':
      return to ? event('moved', 'capacity', from, to) : null;
    case 'switch':
      return to ? event('moved', recordedReason(data.reason), from, to) : null;
    case 'switch-request':
      return to ? event('move-asked', recordedReason(data.reason), from, to) : null;
    case 'move-failed':
      return to ? event('move-failed', moveReason(data.reason), from, to) : null;
    case 'move-pending':
      return to ? event('move-waiting', moveReason(data.reason), from, to) : null;
    case 'editor-move':
      // The same kind records the editor's folder being made or taken over,
      // whose `from` is a folder, not an account: only a move between
      // accounts (or onto one from none) is a switch.
      return to && (data.from === undefined || data.from === null || from)
        ? event('editor-moved', 'follows-active', from, to)
        : null;
    case 'capped': {
      const who = accountName(data.account);
      return who ? event('ran-out', 'capacity', who, null) : null;
    }
    case 'session-start': {
      const who = accountName(data.account);
      return who
        ? event('started', data.continued === true ? 'continued' : 'session-start', null, who)
        : null;
    }
    default:
      return null;
  }
}

/**
 * The moves among `records`, in their order, a run of the same move told as
 * one with its count and the time of the last. The same move is the same in
 * every field, never the same words: the log folds by its message, and
 * "switching to c" said for a move from a and then for one from b is two
 * moves, which is why this reads the records unfolded (readEventRecords).
 */
export function switchEvents(records: readonly EventRecord[]): SwitchEvent[] {
  const out: SwitchEvent[] = [];
  for (const record of records) {
    const event = toSwitchEvent(record);
    if (!event) continue;
    const last = out[out.length - 1];
    if (
      last &&
      last.kind === event.kind &&
      last.from === event.from &&
      last.to === event.to &&
      last.reason === event.reason &&
      last.v === event.v
    ) {
      const count = Math.min(Number.MAX_SAFE_INTEGER, (last.count ?? 1) + (event.count ?? 1));
      out[out.length - 1] = { ...event, count };
    } else {
      out.push(event);
    }
  }
  return out;
}

/**
 * The last `count` moves in the log, oldest first. The log is bounded (see
 * events/log), so reading it whole costs little, and counting after picking
 * the moves out gives `count` moves rather than `count` events of any kind.
 */
export function readSwitchEvents(configHome: string, count: number): SwitchEvent[] {
  return switchEvents(readEventRecords(configHome)).slice(-Math.max(1, count));
}
