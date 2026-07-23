import { getAccount } from '../accounts/registry.js';
import { setActive } from '../state/active.js';
import { syncEditorPointerIfEnabled } from '../editor/junction.js';
import type { CliContext } from '../context.js';

/** Pin the active account (used by `run` and the transparent shim). */
export function useCommand(context: CliContext, name: string): number {
  if (!getAccount(name, context.ctx)) {
    context.out(`account "${name}" not found`);
    return 1;
  }
  setActive(name, context.ctx);
  syncEditorPointerIfEnabled(context); // keep the editor in sync if it is on
  context.out(`active account: ${name}`);
  return 0;
}
