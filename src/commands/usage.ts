import { listAccounts } from '../accounts/registry.js';
import { refreshUsage } from '../usage/usage-store.js';
import type { CliContext } from '../context.js';

function pct(v: number | null): string {
  return v === null ? '  ?' : `${Math.round(v * 100)}%`.padStart(3);
}

function resetIn(reset: number | null, now: number): string {
  if (!reset || reset <= now) return '';
  const mins = Math.round((reset - now) / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return h < 48 ? `${h}h${mins % 60}m` : `${Math.floor(h / 24)}d`;
}

/**
 * Print real per-account subscription usage (5-hour + weekly), fetched from the
 * unified rate-limit signal (one minimal request per account, TTL-cached).
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

  const nameW = Math.max(7, ...accounts.map((a) => a.name.length));
  context.out(`${'ACCOUNT'.padEnd(nameW)}   5h     weekly   per-model (weekly)`);
  for (const a of accounts) {
    const u = snap.accounts[a.name];
    if (!u || (u.fiveHour === null && u.sevenDay === null)) {
      context.out(`${a.name.padEnd(nameW)}   (no usage data)`);
      continue;
    }
    const models = (u.models ?? [])
      .map((m) => {
        const r = resetIn(m.resetsAt ?? null, now);
        return `${m.name} ${pct(m.utilization).trim()}${r ? ` (${r})` : ''}`;
      })
      .join(', ');
    const fiveReset = resetIn(u.fiveHourReset, now);
    const weekReset = resetIn(u.sevenDayReset, now);
    context.out(
      `${a.name.padEnd(nameW)}   ${pct(u.fiveHour)}    ${pct(u.sevenDay)}     ${models || '-'}`,
    );
    context.out(
      `${''.padEnd(nameW)}   ${fiveReset ? `resets ${fiveReset}` : ''}${fiveReset && weekReset ? ' / ' : ''}${weekReset ? `wk ${weekReset}` : ''}`,
    );
  }
  return 0;
}
