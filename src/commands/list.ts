import { listAccounts } from '../accounts/registry.js';
import { getActive } from '../state/active.js';
import { probeAll } from '../health/prober.js';
import { loadLedger } from '../ledger/ledger.js';
import { renderTable } from '../util/table.js';
import { signedInAndNotRejected } from '../health/signed-in.js';
import { getClaude, type CliContext } from '../context.js';

/**
 * Injected in tests so the table can be checked without spawning a probe per
 * account. Driving the real prober makes an assertion depend on a subprocess
 * finishing, which passed on one platform and failed on another once already.
 */
export interface ListCommandDeps {
  probe?: typeof probeAll;
}

/** Show every account with its live health in a table (or JSON with --json). */
export async function listCommand(
  context: CliContext,
  deps: ListCommandDeps = {},
): Promise<number> {
  const accounts = listAccounts(context.ctx);
  if (accounts.length === 0) {
    context.out('no accounts registered (run: ccx add <name>)');
    return 0;
  }

  const active = getActive(context.ctx);
  const ledger = loadLedger(context.ctx);
  const now = Date.now();
  const healths = await (deps.probe ?? probeAll)(accounts, { claude: getClaude(context) });
  const byName = new Map(healths.map((h) => [h.name, h]));
  // The probe reports a refused login as signed in, because the file still
  // looks like one. This table is where someone looks to find out which
  // accounts they can use, so showing yes for a login ccx already knows is
  // finished is the most misleading place to say it.
  const usable = signedInAndNotRejected(healths, accounts, context.ctx);

  const rows = accounts.map((a) => {
    const h = byName.get(a.name);
    const cap = ledger.caps.find((c) => c.account === a.name && (c.capUntil === null || c.capUntil > now));
    return {
      active: a.name === active ? '*' : '',
      name: a.name,
      email: h?.email ?? '',
      plan: h?.plan ?? a.plan ?? '',
      loggedIn: usable.has(a.name) ? 'yes' : 'no',
      cappedUntil: cap ? (cap.capUntil ? new Date(cap.capUntil).toLocaleTimeString() : 'indefinite') : '',
    };
  });

  if (context.json) {
  // Wrapped rather than bare, so every machine-readable output on this CLI has
  // the same envelope. Two of five carrying a schemaVersion was a trap for
  // whoever wrote against the other three.
    context.out(JSON.stringify({ schemaVersion: 1, accounts: rows }, null, 2));
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
