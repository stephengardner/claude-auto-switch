import path from 'node:path';
import { configHome, type PathCtx } from '../config/paths.js';
import { readJsonFile, writeJsonFile } from '../util/fs-json.js';
import { LedgerSchema, type CapRecord, type Ledger } from './ledger.schema.js';

const FILENAME = 'ledger.json';

// -- persistence -----------------------------------------------------------

export function ledgerFilePath(c: PathCtx = {}): string {
  const platform = c.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.join(configHome(c), FILENAME);
}

export function loadLedger(c: PathCtx = {}): Ledger {
  return readJsonFile(ledgerFilePath(c), LedgerSchema) ?? { caps: [] };
}

export function saveLedger(ledger: Ledger, c: PathCtx = {}): void {
  writeJsonFile(ledgerFilePath(c), ledger);
}

// -- pure operations (deterministic over an injected `now`) ----------------

function isActive(cap: { capUntil: number | null }, now: number): boolean {
  return cap.capUntil === null || cap.capUntil > now;
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

/** The set of accounts that cannot run at all at time `now`. */
export function cappedNames(ledger: Ledger, now: number): Set<string> {
  return new Set(ledger.caps.filter((c) => !c.model && isActive(c, now)).map((c) => c.account));
}

/** Accounts whose limit is only about `model` (they still work on other models). */
export function modelCappedNames(ledger: Ledger, now: number, model?: string): Set<string> {
  return new Set(
    ledger.caps
      .filter((c) => c.model && isActive(c, now) && (!model || c.model.toLowerCase() === model.toLowerCase()))
      .map((c) => c.account),
  );
}

/** Every account with any active limit, whatever its scope (for display). */
export function allLimitedNames(ledger: Ledger, now: number): Set<string> {
  return new Set(ledger.caps.filter((c) => isActive(c, now)).map((c) => c.account));
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

  const sameModel = (c: CapRecord): boolean =>
    (c.model ?? '').toLowerCase() === (input.model ?? '').toLowerCase();
  const superseded = (c: CapRecord): boolean =>
    c.account === input.account && (input.model === undefined ? true : sameModel(c));

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
  if (!active.every((c) => c.model === model)) return null; // mixed models: not one story
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
