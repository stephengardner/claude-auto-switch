import { getAccount, updateAccount } from '../accounts/registry.js';
import { tagNote, withTags } from '../accounts/tags.js';
import { selectAccounts } from './tags.js';
import type { CliContext } from '../context.js';

/** Which accounts `ccx enable` and `ccx disable` act on, and tags to add while they do. */
export interface EnableOptions {
  /** Every account carrying all of these, instead of one by name. */
  tagged?: readonly string[] | undefined;
  /** Tags to add to each account changed: `ccx disable lent --tag pat`. */
  tag?: readonly string[] | undefined;
}

function setEnabled(
  context: CliContext,
  name: string | undefined,
  enabled: boolean,
  options: EnableOptions,
): number {
  const selected = selectAccounts(context, { name, tagged: options.tagged });
  if ('refusal' in selected) {
    context.out(selected.refusal);
    return 1;
  }
  const adding = options.tag ?? [];
  // Every change is worked out before any is written, so a bad tag leaves
  // every account as it was rather than half of them changed.
  let changes: Array<{ name: string; tags: string[] | undefined }>;
  try {
    changes = selected.accounts.map((a) => ({
      name: a.name,
      tags: adding.length > 0 ? withTags(a.tags, adding) : undefined,
    }));
  } catch (err) {
    context.out((err as Error).message);
    return 1;
  }
  for (const change of changes) {
    updateAccount(change.name, { enabled, ...(change.tags ? { tags: change.tags } : {}) }, context.ctx);
    const tagged = change.tags ? ` (tagged ${tagNote(change.tags)})` : '';
    context.out(`${enabled ? 'enabled' : 'disabled'} "${change.name}"${tagged}`);
  }
  return 0;
}

/** Include accounts in rotation: one by name, or every one `--tagged`. */
export function enableCommand(context: CliContext, name: string | undefined, options: EnableOptions = {}): number {
  return setEnabled(context, name, true, options);
}

/** Exclude accounts from rotation (kept registered): one by name, or every one `--tagged`. */
export function disableCommand(context: CliContext, name: string | undefined, options: EnableOptions = {}): number {
  return setEnabled(context, name, false, options);
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
