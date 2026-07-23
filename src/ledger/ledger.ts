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

/** Is this account currently capped at time `now`? */
export function isCapped(ledger: Ledger, account: string, now: number): boolean {
  return ledger.caps.some(
    (c) => c.account === account && (c.capUntil === null || c.capUntil > now),
  );
}

/** The set of accounts capped at time `now`. */
export function cappedNames(ledger: Ledger, now: number): Set<string> {
  return new Set(
    ledger.caps.filter((c) => c.capUntil === null || c.capUntil > now).map((c) => c.account),
  );
}

export interface MarkCappedInput {
  account: string;
  now: number;
  reason?: string;
  /** Explicit reset time (epoch ms) if the signal provided one. */
  resetAt?: number | null;
  /** Fallback window when no reset time is known. */
  backoffMinutes?: number;
}

/** Record (or replace) a cap for an account. Returns a new Ledger. */
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
  };

  return { caps: [...ledger.caps.filter((c) => c.account !== input.account), record] };
}

/** Drop caps whose window has passed. Returns a new Ledger. */
export function clearExpired(ledger: Ledger, now: number): Ledger {
  return { caps: ledger.caps.filter((c) => c.capUntil === null || c.capUntil > now) };
}

/** Remove any cap for an account (e.g. after a successful run). Returns a new Ledger. */
export function clearAccount(ledger: Ledger, account: string): Ledger {
  return { caps: ledger.caps.filter((c) => c.account !== account) };
}
