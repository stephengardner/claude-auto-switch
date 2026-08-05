import { listAccounts } from '../accounts/registry.js';
import { getActive } from '../state/active.js';
import { refreshUsage } from '../usage/usage-store.js';
import { renderUsageReport, type UsageAccount } from '../usage/report.js';
import { loginIsKnownDead } from '../usage/dead-login-store.js';
import { credentialFileFingerprint } from '../accounts/credential-vault.js';
import type { CliContext } from '../context.js';

/**
 * Print the full usage picture: every window for every account, what is closest
 * to stopping each one, and where there is room right now.
 */
export async function usageCommand(context: CliContext): Promise<number> {
  const accounts = listAccounts(context.ctx);
  if (accounts.length === 0) {
    context.out('no accounts registered (run: ccx add <name>)');
    return 0;
  }
  const snap = await refreshUsage(accounts, context.ctx);
  const now = Date.now();

  if (context.json) {
    context.out(JSON.stringify(snap.accounts, null, 2));
    return 0;
  }

  const active = getActive(context.ctx);
  const rows: UsageAccount[] = accounts.map((a) => {
    const u = snap.accounts[a.name];
    // Per-model data counts too: an account can have a model window read while
    // the account-wide ones are unknown, and calling that "nothing read" hides
    // real numbers we already have.
    const known =
      u && (u.fiveHour !== null || u.sevenDay !== null || (u.models ?? []).length > 0);
    return {
      name: a.name,
      email: a.email,
      plan: a.plan,
      active: a.name === active,
      // Room means nothing on a login the endpoint has already rejected.
      needsSignIn: loginIsKnownDead(credentialFileFingerprint(a.dir), context.ctx),
      windows: known
        ? [
            { label: '5-hour', used: u.fiveHour, resetsAt: u.fiveHourReset },
            { label: 'weekly', used: u.sevenDay, resetsAt: u.sevenDayReset },
            ...(u.models ?? []).map((m) => ({
              label: m.name,
              used: m.utilization,
              resetsAt: m.resetsAt ?? null,
              modelOnly: true,
            })),
          ]
        : null,
    };
  });

  context.out(
    renderUsageReport(rows, now, {
      color: process.stdout.isTTY === true,
      ...(process.stdout.columns ? { width: process.stdout.columns } : {}),
    }),
  );
  return 0;
}
