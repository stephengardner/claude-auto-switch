import { listAccounts } from '../accounts/registry.js';
import { dashboardCommand } from './dashboard.js';
import type { CliContext } from '../context.js';

/** The first-run getting-started guide, shown when no accounts are registered. */
export function gettingStarted(): string {
  return [
    'claude-auto-switch (ccx) keeps you working across Claude usage limits.',
    '',
    'Get started:',
    '  1. ccx add <name>     log in an account (opens your browser)',
    '  2. ccx add <name>     add another to switch between',
    '  3. ccx run            start a Claude session that auto-switches on a cap',
    '',
    'Then: ccx dashboard for a live view, ccx --help for all commands.',
  ].join('\n');
}

/**
 * Default action for a bare `ccx`: guide new users when there are no accounts,
 * otherwise show a one-shot status glance plus the two most useful next steps.
 */
export async function homeCommand(context: CliContext): Promise<number> {
  if (listAccounts(context.ctx).length === 0) {
    context.out(gettingStarted());
    return 0;
  }
  const code = await dashboardCommand(context, { once: true });
  context.out('');
  context.out('ccx dashboard for a live view  |  ccx run to start a session');
  return code;
}
