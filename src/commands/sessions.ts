import { liveLeases } from '../session/lease.js';
import { STATE_SCHEMA_VERSION } from '../dashboard/state-payload.js';
import type { CliContext } from '../context.js';

/**
 * List the ccx sessions running right now: their pid (which `ccx use --session`
 * targets), the account each is on, and where it is running. Reads the same live
 * leases the renewal-protection uses, so it only ever shows sessions whose
 * process is actually alive.
 */
export function sessionsCommand(context: CliContext): number {
  const leases = liveLeases(context.ctx).sort((a, b) => b.at - a.at);

  if (context.json) {
    context.out(
      JSON.stringify(
        {
          schemaVersion: STATE_SCHEMA_VERSION,
          sessions: leases.map((l) => ({
            pid: l.pid,
            account: l.account,
            ...(l.cwd ? { cwd: l.cwd } : {}),
            lastSeen: l.at,
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (leases.length === 0) {
    context.out('no ccx sessions are running');
    return 0;
  }

  const rows = leases.map((l) => ({
    pid: String(l.pid),
    account: l.account,
    where: l.cwd ?? '-',
  }));
  const wPid = Math.max(3, ...rows.map((r) => r.pid.length));
  const wAcct = Math.max(7, ...rows.map((r) => r.account.length));
  context.out(`${'PID'.padEnd(wPid)}  ${'ACCOUNT'.padEnd(wAcct)}  WHERE`);
  for (const r of rows) {
    context.out(`${r.pid.padEnd(wPid)}  ${r.account.padEnd(wAcct)}  ${r.where}`);
  }
  context.out('');
  context.out('switch one in place:  ccx use <account> --session <pid>   (or --here in its folder)');
  return 0;
}
