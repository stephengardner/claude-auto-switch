import { loadConfigFile, saveConfig } from '../config/config.js';
import type { AccountOrder } from '../selector/selector.js';
import type { CliContext } from '../context.js';

const MODES: AccountOrder[] = ['most-room', 'priority'];

function describe(order: AccountOrder): string {
  return order === 'most-room'
    ? 'most-room: rotation reaches for the LEAST-USED account first (the one with the most headroom on its 5-hour or weekly window)'
    : 'priority: rotation reaches for the lowest-priority-number account first (the classic order)';
}

/**
 * Show or set which account rotation reaches for first.
 *
 * `most-room` (the default) spreads work toward whichever account has used the
 * least, delaying the moment any one account runs out. `priority` is the classic
 * fixed order. A pinned account (`ccx use`) still wins either way, and priority
 * remains the tiebreak when two accounts are equally roomy.
 */
export function orderCommand(context: CliContext, mode?: string): number {
  const current = context.config.rotation.accountOrder;

  if (mode === undefined || mode === 'status') {
    context.out(describe(current));
    const other = current === 'most-room' ? 'priority' : 'most-room';
    context.out(`switch with: ccx order ${other}`);
    return 0;
  }

  if (!MODES.includes(mode as AccountOrder)) {
    context.out(`unknown mode "${mode}" (use: most-room, priority)`);
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
