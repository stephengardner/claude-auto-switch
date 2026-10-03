import { loadConfigFile, saveConfig } from '../config/config.js';
import type { AccountOrder } from '../selector/selector.js';
import type { CliContext } from '../context.js';

const MODES: AccountOrder[] = ['smart', 'most-room', 'priority'];

function describe(order: AccountOrder): string {
  switch (order) {
    case 'smart':
      return 'smart: rotation reaches for the account that can run longest before any window stops it (5-hour and weekly together), and among those, the one whose weekly budget would go unused soonest';
    case 'most-room':
      return 'most-room: rotation reaches for the LEAST-USED account first (the one with the most headroom on its 5-hour or weekly window)';
    default:
      return 'priority: rotation reaches for the lowest-priority-number account first (the classic order)';
  }
}

/**
 * Show or set which account rotation reaches for first.
 *
 * `smart` (the default) goes where work can run longest, then where weekly
 * budget would otherwise expire unused (usage/runway.ts). `most-room` spreads
 * work toward whichever account has used the least. `priority` is the classic
 * fixed order. A pinned account (`ccx use`) still wins either way, and priority
 * remains the tiebreak when two accounts are equally roomy.
 */
export function orderCommand(context: CliContext, mode?: string): number {
  const current = context.config.rotation.accountOrder;

  if (mode === undefined || mode === 'status') {
    context.out(describe(current));
    context.out(`switch with: ccx order ${MODES.filter((m) => m !== current).join(' | ')}`);
    return 0;
  }

  if (!MODES.includes(mode as AccountOrder)) {
    context.out(`unknown mode "${mode}" (use: ${MODES.join(', ')})`);
    return 1;
  }
  const order = mode as AccountOrder;

  // Read only the FILE (not the env-merged config) so flipping this setting
  // preserves what is written by hand and never bakes a temporary CAS_* override
  // into the file.
  const onDisk = loadConfigFile(context.ctx);
  saveConfig({ ...onDisk, rotation: { ...onDisk.rotation, accountOrder: order } }, context.ctx);
  context.out(describe(order));
  return 0;
}
