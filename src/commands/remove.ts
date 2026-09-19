import { clearCredential } from '../accounts/credential-vault.js';
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

  const deregister = (): void => {
    removeAccount(name, context.ctx);
    if (getActive(context.ctx) === name) setActive(null, context.ctx);
  };

  if (options.purge) {
    // Never recursively delete a path outside the profiles tree, even if the
    // registry entry was crafted or a custom --dir escaped it.
    const profiles = profilesDir(context.config, context.ctx);
    if (!isInside(profiles, account.dir)) {
      try {
        clearCredential(account.dir);
      } catch {
        context.out(
          `could not clear credentials for "${name}" at ${account.dir}; account remains registered; retry --purge`,
        );
        return 1;
      }
      deregister();
      context.out(
        `deregistered "${name}", but did NOT purge ${account.dir} (outside ${profiles}); delete it yourself if intended`,
      );
      return 0;
    }
    try {
      clearCredential(account.dir);
      rmSync(account.dir, { recursive: true, force: true });
    } catch {
      context.out(
        `could not fully purge "${name}" at ${account.dir}; account remains registered, but credentials or files may have been removed; retry --purge`,
      );
      return 1;
    }
    deregister();
    context.out(`removed "${name}" and purged ${account.dir}`);
  } else {
    deregister();
    context.out(`removed "${name}" (profile folder kept at ${account.dir})`);
  }
  return 0;
}
