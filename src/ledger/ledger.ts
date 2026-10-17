import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { acquireOwnedLock } from '../claude/locks.js';
import { configHome, type PathCtx } from '../config/paths.js';
import { appendEvent } from '../events/log.js';
import { readJsonFile, writeJsonFile } from '../util/fs-json.js';
import { LedgerSchema, type CapRecord, type Ledger } from './ledger.schema.js';

const FILENAME = 'ledger.json';

/**
 * Every change holds this lock while it reads the file, applies the change and
 * writes the result, a few milliseconds. A holder that has exited is taken over
 * at once, and a lock that names no holder after five seconds. One whose
 * holder is still running is waited for until the lock is a minute old, then
 * taken over; the wait runs a little past that, so that it ends in the
 * takeover, never in a write past a running holder. See updateLedger.
 */
const LONGEST_HOLD_MS = 60_000;
const LOCK = { waitMs: LONGEST_HOLD_MS + 5_000, staleMs: 5_000, maxHoldMs: LONGEST_HOLD_MS };

// -- persistence -----------------------------------------------------------

export function ledgerFilePath(c: PathCtx = {}): string {
  const platform = c.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.join(configHome(c), FILENAME);
}

/**
 * The ledger as it is now, read without the lock: for deciding, never for
 * writing back, since a ledger changed from this copy erases whatever another
 * process recorded after it was read. Every write replaces the file in one
 * step, so a read gets the old ledger or the new one, never part of one.
 */
export function loadLedger(c: PathCtx = {}): Ledger {
  return readJsonFile(ledgerFilePath(c), LedgerSchema) ?? { caps: [] };
}

/** Set while a change runs, so a change that calls updateLedger itself is refused rather than written over. */
let changing = false;

/**
 * The one way to change the ledger: read it, apply `change` and write the
 * result, as one step under the ledger's lock, so a limit another process
 * records at the same moment is never written over. `change` is handed the
 * ledger as it is now and returns the new one; returning the one it was handed
 * writes nothing. Returns the ledger as it now stands. A change must not call
 * updateLedger: that throws, since it would wait on its own lock and its write
 * would then be overwritten by the outer one.
 *
 * A running holder is waited for until its lock is older than the longest
 * hold, however long that takes. A holder needs milliseconds, so one that has
 * held for seconds was held up by the machine (a stall, a disk that stopped
 * answering) and will finish; written past it, this change would be lost when
 * it resumes and writes back what it read before.
 * Past the longest hold the lock is taken over whatever its pid says, since
 * that pid may by now be another program's. The wait freezes whatever asked,
 * a session's terminal included, for as long as the holder holds.
 *
 * A lock that cannot be made at all, or is not free when `waitMs` runs out,
 * is written past rather than drop the change, which would lose a limit for
 * certain, and the event log says so. The two changes can then erase each
 * other.
 */
export function updateLedger(
  c: PathCtx,
  change: (ledger: Ledger) => Ledger,
  options: { waitMs?: number } = {},
): Ledger {
  if (changing) throw new Error('updateLedger was called from inside a change to the ledger');
  const file = ledgerFilePath(c);
  const waitMs = options.waitMs ?? LOCK.waitMs;
  // The lock lives beside the ledger, so a first write needs the folder first.
  mkdirSync(path.dirname(file), { recursive: true });
  const lock = acquireOwnedLock(`${file}.lock`, { ...LOCK, waitMs });
  try {
    const current = loadLedger(c);
    changing = true;
    let next: Ledger;
    try {
      next = change(current);
    } finally {
      changing = false;
    }
    if (next === current) return current;
    writeJsonFile(file, next);
    if (!lock.held) {
      const why = lock.unusable
        ? `the lock could not be made (${lock.unusable})`
        : `the lock was not free within ${waitMs / 1000} s`;
      appendEvent(
        configHome(c),
        `ledger written without its lock: ${why}; a change another session made at that moment may be lost`,
        Date.now(),
        { kind: 'ledger-unlocked', data: { waitMs, ...(lock.unusable ? { unusable: lock.unusable } : {}) } },
      );
    }
    return next;
  } finally {
    lock.release();
  }
}

// -- pure operations (deterministic over an injected `now`) ----------------

function isActive(cap: { capUntil: number | null }, now: number): boolean {
  return cap.capUntil === null || cap.capUntil > now;
}

/**
 * Are these the same model?
 *
 * One rule, used everywhere a model name is compared here. The name arrives
 * from three places that disagree about spelling ("Fable" from the usage API,
 * "fable" from config, "claude-fable-5" from a flag), so a strict comparison in
 * one function and a case-insensitive one in another reads the same ledger two
 * different ways: caps for "Fable" and "fable" looked like two different models
 * and the last-resort path gave up rather than saying which one was out.
 */
function sameModel(one: string | undefined, other: string | undefined): boolean {
  return (one ?? '').toLowerCase() === (other ?? '').toLowerCase();
}

/**
 * Is this account unusable at time `now`?
 *
 * Only an account-wide limit makes an account unusable. A limit on ONE model
 * leaves everything else about the account working, so it must not count here:
 * treating it as unusable is what stops a session starting on a model that is
 * perfectly available.
 */
export function isCapped(ledger: Ledger, account: string, now: number): boolean {
  return ledger.caps.some((c) => c.account === account && !c.model && isActive(c, now));
}

/**
 * Whether a limit is on the ledger and still holds at `now`: the whole
 * account's, which takes in every model, or, given `model`, that model's on
 * the account. A limit whose reset has passed is not, so the account meeting
 * a limit again after that is news.
 */
export function limitOnLedger(ledger: Ledger, account: string, model: string | undefined, now: number): boolean {
  return ledger.caps.some(
    (c) =>
      c.account === account && isActive(c, now) && (!c.model || (model !== undefined && sameModel(c.model, model))),
  );
}

/** The set of accounts that cannot run at all at time `now`. */
export function cappedNames(ledger: Ledger, now: number): Set<string> {
  return new Set(ledger.caps.filter((c) => !c.model && isActive(c, now)).map((c) => c.account));
}

/**
 * When the account-wide limit recorded for `account` ends, for one active at
 * `now` that has an end; undefined when there is none.
 */
export function accountCapEnd(ledger: Ledger, account: string, now: number): number | undefined {
  const cap = ledger.caps.find((c) => c.account === account && !c.model && isActive(c, now));
  return cap?.capUntil ?? undefined;
}



/**
 * Which (account, model) pairs are known spent right now, from limits recorded
 * EARLIER, including by other runs.
 *
 * Rotation plans from what it has measured plus what it has proven during the
 * run, and neither of those sees a limit an earlier run confirmed. Without
 * this, a fresh run offers a model back to the account it just ran out on, and
 * only rediscovers the limit by hitting it again.
 */
export function activeModelCaps(
  ledger: Ledger,
  now: number,
): Array<{ account: string; model: string }> {
  return ledger.caps
    .filter((c): c is typeof c & { model: string } => Boolean(c.model) && isActive(c, now))
    .map((c) => ({ account: c.account, model: c.model }));
}

export interface MarkCappedInput {
  account: string;
  now: number;
  reason?: string;
  /** Explicit reset time (epoch ms) if the signal provided one. */
  resetAt?: number | null;
  /** Fallback window when no reset time is known. */
  backoffMinutes?: number;
  /** Set when only ONE MODEL is out, rather than the whole account. */
  model?: string;
}

/**
 * Record (or replace) a cap for an account. Returns a new Ledger.
 *
 * A model-scoped write replaces only the record for THAT model, so an account
 * can hold one per model. Replacing everything for the account was fine while
 * caps were only read as "can this account run at all", and wrong the moment
 * rotation started planning from them: capping Fable and then Opus on one
 * account erased the Fable record, and the next run offered Fable back to an
 * account whose Fable window was demonstrably closed.
 *
 * An account-wide write still replaces everything for the account, which is
 * right: nothing about that account is usable, so no per-model detail survives
 * as anything but noise.
 */
export function markCapped(ledger: Ledger, input: MarkCappedInput): Ledger {
  const capUntil =
    input.resetAt !== undefined && input.resetAt !== null
      ? input.resetAt
      : input.backoffMinutes !== undefined
        ? input.now + input.backoffMinutes * 60_000
        : null;

  const record: CapRecord = {
    account: input.account,
    capUntil,
    reason: input.reason ?? 'usage cap',
    at: input.now,
    ...(input.model ? { model: input.model } : {}),
  };

  const superseded = (c: CapRecord): boolean =>
    c.account === input.account && (input.model === undefined || sameModel(c.model, input.model));

  return { caps: [...ledger.caps.filter((c) => !superseded(c)), record] };
}

/**
 * When every current limit is about ONE MODEL rather than whole accounts, this
 * describes it: the model, and the soonest it frees up.
 *
 * This is the difference between "you cannot work" and "you cannot work on this
 * model". Treating the second as the first is how a Fable limit turns into an
 * apparently unusable setup, when switching models would have carried on fine.
 */
export function modelOnlyLimit(
  ledger: Ledger,
  now: number,
): { model: string; resetsAt: number | null } | null {
  const active = ledger.caps.filter((c) => c.capUntil === null || c.capUntil > now);
  if (active.length === 0) return null;
  if (!active.every((c) => typeof c.model === 'string' && c.model.length > 0)) return null;
  const model = active[0]!.model!;
  if (!active.every((c) => sameModel(c.model, model))) return null; // mixed: not one story
  const resets = active
    .map((c) => c.capUntil)
    .filter((t): t is number => typeof t === 'number')
    .sort((a, b) => a - b);
  return { model, resetsAt: resets[0] ?? null };
}

/** Drop caps whose window has passed. Returns a new Ledger. */
export function clearExpired(ledger: Ledger, now: number): Ledger {
  return { caps: ledger.caps.filter((c) => c.capUntil === null || c.capUntil > now) };
}

/** Remove any cap for an account (e.g. after a successful run). Returns a new Ledger. */
export function clearAccount(ledger: Ledger, account: string): Ledger {
  return { caps: ledger.caps.filter((c) => c.account !== account) };
}

/** A run on `account` that started at `startedAt` and finished fine, on `model` (null when not known). */
export interface FineRun {
  account: string;
  model: string | null;
  startedAt: number;
}

/**
 * Remove what a run that finished fine shows is over, and nothing else: its
 * account's account-wide caps, and its cap for the model it ran when that is
 * known, recorded before it started. A cap on another model says nothing about
 * this one, and one recorded once it had started, even in the same
 * millisecond, may be another session seeing the account refuse while it ran.
 * Keeping a cap only rests an account a little longer; a wrong clear sends
 * sessions to one that is out. Returns the same ledger when there is none to
 * remove, so updateLedger writes nothing.
 */
export function clearDisproved(ledger: Ledger, run: FineRun): Ledger {
  const disproved = (c: CapRecord): boolean =>
    c.account === run.account &&
    c.at < run.startedAt &&
    (!c.model || (run.model !== null && sameModel(c.model, run.model)));
  const caps = ledger.caps.filter((c) => !disproved(c));
  return caps.length === ledger.caps.length ? ledger : { caps };
}

/**
 * One thing a run found out, applied to the ledger as the file stands when it
 * is written (updateLedger), never by writing back a copy read earlier: a
 * limit it confirmed, or a run that finished fine.
 */
export type LedgerChange = { kind: 'capped'; cap: MarkCappedInput } | ({ kind: 'ran' } & FineRun);

export function applyLedgerChange(ledger: Ledger, change: LedgerChange): Ledger {
  return change.kind === 'capped' ? markCapped(ledger, change.cap) : clearDisproved(ledger, change);
}
