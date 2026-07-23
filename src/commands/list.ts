import { listAccounts } from '../accounts/registry.js';
import { getActive } from '../state/active.js';
import { probeAll } from '../health/prober.js';
import { loadLedger } from '../ledger/ledger.js';
import { renderTable } from '../util/table.js';
import { getClaude, type CliContext } from '../context.js';

/** Show every account with its live health in a table (or JSON with --json). */
export async function listCommand(context: CliContext): Promise<number> {
  const accounts = listAccounts(context.ctx);
  if (accounts.length === 0) {
    context.out('no accounts registered (run: ccx add <name>)');
    return 0;
  }

  const active = getActive(context.ctx);
  const ledger = loadLedger(context.ctx);
  const now = Date.now();
  const healths = await probeAll(accounts, { claude: getClaude(context) });
  const byName = new Map(healths.map((h) => [h.name, h]));

  const rows = accounts.map((a) => {
    const h = byName.get(a.name);
    const cap = ledger.caps.find((c) => c.account === a.name && (c.capUntil === null || c.capUntil > now));
    return {
      active: a.name === active ? '*' : '',
      name: a.name,
      email: h?.email ?? '',
      plan: h?.plan ?? a.plan ?? '',
      loggedIn: h?.loggedIn ? 'yes' : 'no',
      cappedUntil: cap ? (cap.capUntil ? new Date(cap.capUntil).toLocaleTimeString() : 'indefinite') : '',
    };
  });

  if (context.json) {
    context.out(JSON.stringify(rows, null, 2));
    return 0;
  }

  context.out(
    renderTable(rows, [
      { key: 'active', header: '' },
      { key: 'name', header: 'ACCOUNT' },
      { key: 'email', header: 'EMAIL' },
      { key: 'plan', header: 'PLAN' },
      { key: 'loggedIn', header: 'LOGGED IN' },
      { key: 'cappedUntil', header: 'CAPPED UNTIL' },
    ]),
  );
  return 0;
}
