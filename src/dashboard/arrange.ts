import { accountStatus, type AccountStatus } from './account-status.js';
import type { DashboardAccount } from './render.js';

/**
 * The order the dashboard draws accounts in, and the block each belongs to.
 *
 * Kept apart from the drawing because the live loop needs the same order: its
 * cursor counts rows, so a row number has to mean the same account to the keys
 * as it does on screen.
 */

/**
 * `usable`: rotation ranks it, or nothing is stopping it.
 * `out`: something is stopping it and rotation does not rank it.
 * `off`: disabled or signed out, which no reset brings back.
 */
export type Block = 'usable' | 'out' | 'off';

export interface Placed {
  account: DashboardAccount;
  status: AccountStatus;
  block: Block;
}

function blockOf(account: DashboardAccount, status: AccountStatus): Block {
  if (status.state === 'disabled' || status.state === 'logged-out') return 'off';
  // An account rotation ranks is one it would move a session to, even when the
  // shared status calls it blocked (its preferred model is spent, and it can
  // run the next one in the chain).
  return account.pick || status.state === 'ready' ? 'usable' : 'out';
}

/**
 * Accounts in the order they are drawn: usable ones in pick order, then the
 * ones out of room with the soonest back first, then the ones that are off.
 * Every tie keeps the order the accounts came in, so arranging the result
 * again changes nothing.
 */
export function arrange(accounts: readonly DashboardAccount[], model: string | null, now: number): Placed[] {
  const placed = accounts.map((account) => {
    const status = accountStatus(account, model, now);
    return { account, status, block: blockOf(account, status) };
  });
  const of = (block: Block): Placed[] => placed.filter((p) => p.block === block);
  const rank = (p: Placed): number => p.account.pick?.rank ?? Number.POSITIVE_INFINITY;
  const back = (p: Placed): number => p.status.until ?? Number.POSITIVE_INFINITY;
  const signedOutFirst = (p: Placed): number => (p.status.state === 'logged-out' ? 0 : 1);
  // Compared rather than subtracted: two unranked accounts are both at
  // infinity, and infinity minus infinity is not a number a sort can use.
  const by =
    (key: (p: Placed) => number) =>
    (a: Placed, b: Placed): number =>
      key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
  return [...of('usable').sort(by(rank)), ...of('out').sort(by(back)), ...of('off').sort(by(signedOutFirst))];
}

/** The accounts alone, in the order they are drawn. */
export function inDisplayOrder(
  accounts: readonly DashboardAccount[],
  model: string | null,
  now: number,
): DashboardAccount[] {
  return arrange(accounts, model, now).map((p) => p.account);
}

/**
 * The row the cursor belongs on after the rows were rebuilt: the row of the
 * account it was on, or the same row number when that account is gone.
 */
export function keepSelection(
  accounts: ReadonlyArray<{ name: string }>,
  name: string | undefined,
  index: number,
): number {
  const at = name === undefined ? -1 : accounts.findIndex((a) => a.name === name);
  return at >= 0 ? at : index;
}
