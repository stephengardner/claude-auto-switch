import { listAccounts } from '../accounts/registry.js';
import { getActive, setActive } from '../state/active.js';
import { probeAll } from '../health/prober.js';
import { select } from '../selector/selector.js';
import { syncEditorPointerIfEnabled } from '../editor/junction.js';
import { getClaude, type CliContext } from '../context.js';

/** Switch the active account to the next healthy one (skips the current active). */
export async function rotateCommand(context: CliContext): Promise<number> {
  const accounts = listAccounts(context.ctx);
  const active = getActive(context.ctx);
  const healths = await probeAll(accounts, { claude: getClaude(context) });
  const loggedIn = new Set(healths.filter((h) => h.loggedIn).map((h) => h.name));

  const others = accounts.filter((a) => a.name !== active);
  const pool = others.length > 0 ? others : accounts;
  const result = select({ accounts: pool, loggedIn, capped: new Set() });
  if (!result.ok) {
    context.out(`cannot rotate: ${result.reason}`);
    return 1;
  }

  setActive(result.account.name, context.ctx);
  syncEditorPointerIfEnabled(context);
  context.out(`rotated to: ${result.account.name}`);
  return 0;
}
