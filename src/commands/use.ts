import { getAccount } from '../accounts/registry.js';
import { setActive } from '../state/active.js';
import { writeSwitchRequest } from '../state/switch-request.js';
import { syncEditorPointerIfEnabled } from '../editor/junction.js';
import type { CliContext } from '../context.js';

/** Set the active account. If a session is live, it switches to it in place. */
export function useCommand(context: CliContext, name: string): number {
  if (!getAccount(name, context.ctx)) {
    context.out(`account "${name}" not found`);
    return 1;
  }
  setActive(name, context.ctx);
  syncEditorPointerIfEnabled(context); // keep the editor in sync if it is on
  // Ask a running session to switch in place; a no-op when nothing is running.
  writeSwitchRequest(name, Date.now(), context.ctx);
  context.out(`active account: ${name}`);
  return 0;
}
