import { getAccount, updateAccount } from '../accounts/registry.js';
import type { CliContext } from '../context.js';

function setEnabled(context: CliContext, name: string, enabled: boolean): number {
  if (!getAccount(name, context.ctx)) {
    context.out(`account "${name}" not found`);
    return 1;
  }
  updateAccount(name, { enabled }, context.ctx);
  context.out(`${enabled ? 'enabled' : 'disabled'} "${name}"`);
  return 0;
}

/** Include an account in rotation. */
export function enableCommand(context: CliContext, name: string): number {
  return setEnabled(context, name, true);
}

/** Exclude an account from rotation (kept registered). */
export function disableCommand(context: CliContext, name: string): number {
  return setEnabled(context, name, false);
}

/** Set an account's priority (lower is preferred earlier). */
export function priorityCommand(context: CliContext, name: string, value: string): number {
  if (!getAccount(name, context.ctx)) {
    context.out(`account "${name}" not found`);
    return 1;
  }
  const priority = Number(value);
  if (!Number.isInteger(priority)) {
    context.out(`priority must be an integer, got "${value}"`);
    return 1;
  }
  updateAccount(name, { priority }, context.ctx);
  context.out(`set priority of "${name}" to ${priority}`);
  return 0;
}
