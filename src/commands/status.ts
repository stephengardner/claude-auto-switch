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
  context.out(JSON.stringify(healths, null, 2));
  return 0;
}
