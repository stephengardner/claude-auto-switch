import { getAccount } from '../accounts/registry.js';
import { setActive } from '../state/active.js';
import { writeSwitchRequest } from '../state/switch-request.js';
import { syncEditorPointerIfEnabled } from '../editor/junction.js';
import type { CliContext } from '../context.js';

/** Set the active account. A live session moves to it (seamless, or --now restart). */
export function useCommand(context: CliContext, name: string, opts: { now?: boolean } = {}): number {
  if (!getAccount(name, context.ctx)) {
    context.out(`account "${name}" not found`);
    return 1;
  }
  setActive(name, context.ctx);
  syncEditorPointerIfEnabled(context); // keep the editor in sync if it is on
  // Ask a running session to switch; seamless by default, instant restart with
  // --now. A no-op when nothing is running.
  writeSwitchRequest(name, Date.now(), opts.now ? 'restart' : 'seamless', context.ctx);
  context.out(`active account: ${name}`);
  return 0;
}
