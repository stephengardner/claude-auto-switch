import { existsSync } from 'node:fs';
import { listAccounts } from '../accounts/registry.js';
import { usageConstraints, type Constraint } from '../dashboard/account-status.js';
import type { DashboardAccount } from '../dashboard/render.js';
import { humanWait } from '../usage/report.js';
import { desktopAccount, desktopConfigPath } from './desktop-app.js';
import { liveDesktopConversations, type DesktopConversation } from './desktop-sessions.js';
import type { CliContext } from '../context.js';

/**
 * Claude Desktop in two lines, for the dashboard: what it is spending, and the
 * keys that act on it. Null when Desktop is not in use on this machine, so a
 * terminal-only setup sees no trace of it.
 */

const WHEN_SHORT = { off: 'by hand', limit: 'at a limit', credits: 'before credits' } as const;

function spentShort(constraints: Constraint[], now: number): string | null {
  const first = constraints[0];
  if (!first) return null;
  const what = first.label === '5h' ? '5-hour' : first.label === 'week' ? 'week' : first.label;
  const back = first.until ? humanWait(first.until, now) : '';
  return back ? `${what} spent for ${back}` : `${what} spent`;
}

export function desktopSummary(
  context: CliContext,
  usageOf: (account: string) => DashboardAccount['usage'] | undefined,
  now: number,
  conversations: () => DesktopConversation[] = () => liveDesktopConversations(context.ctx),
): { line: string; keys: string } | null {
  const open = conversations();
  const account = desktopAccount(listAccounts(context.ctx), context.ctx);
  if (open.length === 0 && !account && !existsSync(desktopConfigPath(context.ctx))) return null;

  const spent = account
    ? spentShort(usageConstraints(usageOf(account), context.config.rotation.modelPreference[0] ?? null, now), now)
    : null;
  const busy = open.filter((c) => c.status === 'busy').length;
  // "past its plan", not "spending credits": whether credits are turned on for
  // that account is not something ccx can see.
  const who = account ? `on ${account}${spent ? `, ${spent} (past its plan)` : ''}` : 'on an account ccx does not have';
  const what = open.length === 0 ? 'nothing open' : `${busy} busy, ${open.length - busy} idle`;
  const { handoff, mode, prompt } = context.config.desktop;
  return {
    line: `Desktop  ${who} · ${what}`,
    keys:
      `d moves ${WHEN_SHORT[handoff]}  ·  m as ${mode === 'fork' ? 'a copy' : 'itself'}  ·  ` +
      `t "${prompt}"  ·  D move one`,
  };
}
