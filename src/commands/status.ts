import { listAccounts } from '../accounts/registry.js';
import { probeAll } from '../health/prober.js';
import { getClaude, type CliContext } from '../context.js';

/** Print detailed health JSON for one account, or all of them. */
export async function statusCommand(context: CliContext, name?: string): Promise<number> {
  const accounts = listAccounts(context.ctx);
  const targets = name ? accounts.filter((a) => a.name === name) : accounts;
  if (name && targets.length === 0) {
    context.out(`account "${name}" not found`);
    return 1;
  }

  const healths = await probeAll(targets, { claude: getClaude(context) });
  // Wrapped rather than bare, so every machine-readable output on this CLI has
  // the same envelope. Two of five carrying a schemaVersion was a trap for
  // whoever wrote against the other three.
  context.out(JSON.stringify({ schemaVersion: 1, accounts: healths }, null, 2));
  return 0;
}
