import { listAccounts } from '../accounts/registry.js';
import { getActive, setActive } from './active.js';
import { loadLedger, cappedNames } from '../ledger/ledger.js';
import { select } from '../selector/selector.js';
import { syncEditorPointerIfEnabled } from '../editor/junction.js';
import type { CliContext } from '../context.js';

/**
 * If the active account is no longer usable (capped, logged out, or disabled),
 * advance it to the healthiest eligible account and keep the editor pointer in
 * sync. This is what makes a terminal cap carry over to the editor: the shared
 * active account moves, and the editor's next chat follows it.
 *
 * `loggedIn` is passed in so callers that already probed health do not re-probe.
 * Returns the account now active, or null if nothing is usable.
 */
export function advanceActiveToHealthy(context: CliContext, loggedIn: Set<string>): string | null {
  const accounts = listAccounts(context.ctx);
  const active = getActive(context.ctx);
  const capped = cappedNames(loadLedger(context.ctx), Date.now());

  const activeAccount = accounts.find((a) => a.name === active);
  const activeStillOk =
    !!activeAccount && activeAccount.enabled && loggedIn.has(active!) && !capped.has(active!);
  if (activeStillOk) return active;

  const sel = select({ accounts, loggedIn, capped, ...(active ? { pinned: active } : {}) });
  if (!sel.ok) return active ?? null;
  if (sel.account.name !== active) {
    setActive(sel.account.name, context.ctx);
    syncEditorPointerIfEnabled(context);
  }
  return sel.account.name;
}
