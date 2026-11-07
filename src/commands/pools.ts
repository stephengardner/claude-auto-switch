import { getAccount, listAccounts, updateAccount } from '../accounts/registry.js';
import { normalizePool, poolIndex } from '../accounts/pools.js';
import type { CliContext } from '../context.js';
import { answer, refuse } from './json-answer.js';

/**
 * `ccx pool`, `ccx unpool` and `ccx pools`. What a pool is lives in
 * accounts/pools; this is only the commands around it.
 */

/** `ccx pool <account> <pool>`: put the account in a pool, out of any it was in. */
export function poolCommand(context: CliContext, name: string, pool: string): number {
  const account = getAccount(name, context.ctx);
  if (!account) return refuse(context, `account "${name}" not found`);
  let next: string;
  try {
    next = normalizePool(pool);
  } catch (err) {
    return refuse(context, (err as Error).message);
  }
  const before = account.pool ?? null;
  updateAccount(name, { pool: next }, context.ctx);
  return answer(
    context,
    { account: name, pool: next, previous: before },
    before !== null && before !== next
      ? `"${name}" is in pool ${next} (was ${before})`
      : `"${name}" is in pool ${next}`,
  );
}

/** `ccx unpool <account>`: take the account out of its pool. */
export function unpoolCommand(context: CliContext, name: string): number {
  const account = getAccount(name, context.ctx);
  if (!account) return refuse(context, `account "${name}" not found`);
  const before = account.pool ?? null;
  updateAccount(name, { pool: undefined }, context.ctx);
  return answer(
    context,
    { account: name, pool: null, previous: before },
    before !== null ? `"${name}" is in no pool (was ${before})` : `"${name}" was in no pool`,
  );
}

/** `ccx pools`: every pool in use, with the accounts in it. */
export function poolsCommand(context: CliContext): number {
  const accounts = listAccounts(context.ctx);
  const enabled = new Map(accounts.map((a) => [a.name, a.enabled]));
  const index = poolIndex(accounts);
  const outside = accounts.filter((a) => a.pool === undefined).map((a) => a.name);
  if (context.json) {
    return answer(
      context,
      {
        pools: index.map((p) => ({
          pool: p.pool,
          accounts: p.accounts.map((n) => ({ name: n, enabled: enabled.get(n) === true })),
        })),
        unpooled: outside,
      },
      '',
    );
  }
  if (index.length === 0) {
    context.out('no account is in a pool yet (ccx pool <account> <pool>)');
    return 0;
  }
  const width = Math.max(...index.map((p) => p.pool.length));
  for (const p of index) {
    const names = p.accounts.map((n) => (enabled.get(n) === true ? n : `${n} (disabled)`));
    context.out(`${p.pool.padEnd(width)}  ${names.join(', ')}`);
  }
  if (outside.length > 0) context.out(`${'(none)'.padEnd(width)}  ${outside.join(', ')}`);
  return 0;
}
