import { normalizeLabel } from './tags.js';

/**
 * Pools: the one group an account is drawn from (`lanes`, `bots`, `mine`), so
 * a program that hands accounts out, a fleet of agents say, can take them from
 * one group and leave the rest alone.
 *
 * A tag says what an account IS, and an account carries many; a pool says
 * which group it is drawn FROM, so it is in one at most. Kept on the account's
 * own record (accounts.json), like its tags, so a rename keeps it and a
 * removal drops it. Written by the same rule as a tag (accounts/tags).
 *
 * ccx's own rotation does not read pools: a pool changes nothing about where a
 * session moves (docs/reading-ccx-from-another-program.md says what it would
 * take). Pure, so the commands and `ccx state` take their answers from here.
 */

/** A pool's name as it is stored, or the refusal, naming it, for one that cannot be. */
export function normalizePool(raw: string): string {
  return normalizeLabel(raw, 'pool');
}

/**
 * The `pool` field as accounts.json holds it, in the form it is compared in
 * (trimmed, lowercased), or undefined for none. Never checked further, so a
 * hand edit is kept through a write and can be seen and replaced, as with
 * tags; anything that is not text reads as no pool rather than making the
 * accounts unreadable.
 */
export function storedPool(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const pool = raw.trim().toLowerCase();
  return pool === '' ? undefined : pool;
}

/** Every pool in use, sorted, with the accounts in it in the order given. */
export function poolIndex(
  accounts: ReadonlyArray<{ name: string; pool?: string | undefined }>,
): Array<{ pool: string; accounts: string[] }> {
  const index = new Map<string, string[]>();
  for (const account of accounts) {
    const pool = storedPool(account.pool);
    if (pool !== undefined) index.set(pool, [...(index.get(pool) ?? []), account.name]);
  }
  return [...index.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([pool, names]) => ({ pool, accounts: names }));
}
