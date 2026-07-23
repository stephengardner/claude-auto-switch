import { rmSync } from 'node:fs';
import { getAccount, removeAccount } from '../accounts/registry.js';
import { getActive, setActive } from '../state/active.js';
import { profilesDir } from '../config/paths.js';
import { isInside } from '../util/names.js';
import type { CliContext } from '../context.js';

export interface RemoveOptions {
  /** Also delete the account's profile folder (and its credentials). */
  purge?: boolean;
}

/** Deregister an account. Keeps its profile folder unless --purge is given. */
export function removeCommand(
  context: CliContext,
  name: string,
  options: RemoveOptions = {},
): number {
  const account = getAccount(name, context.ctx);
  if (!account) {
    context.out(`account "${name}" not found`);
    return 1;
  }

  removeAccount(name, context.ctx);
  if (getActive(context.ctx) === name) setActive(null, context.ctx);

  if (options.purge) {
    // Never recursively delete a path outside the profiles tree, even if the
    // registry entry was crafted or a custom --dir escaped it.
    const profiles = profilesDir(context.config, context.ctx);
    if (!isInside(profiles, account.dir)) {
      context.out(
        `deregistered "${name}", but did NOT purge ${account.dir} (outside ${profiles}); delete it yourself if intended`,
      );
      return 0;
    }
    rmSync(account.dir, { recursive: true, force: true });
    context.out(`removed "${name}" and purged ${account.dir}`);
  } else {
    context.out(`removed "${name}" (profile folder kept at ${account.dir})`);
  }
  return 0;
}
