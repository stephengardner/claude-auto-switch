import { clearCredential } from '../accounts/credential-vault.js';
import { rmSync } from 'node:fs';
import { removeAccount } from '../accounts/registry.js';
import { purgeRefusal, removalStanding } from '../accounts/removal.js';
import { getActive, setActive } from '../state/active.js';
import { profilesDir } from '../config/paths.js';
import { liveLeases, type SessionLease } from '../session/lease.js';
import type { CliContext } from '../context.js';

export interface RemoveOptions {
  /** Also delete the account's profile folder (and its credentials). */
  purge?: boolean;
}

/**
 * Deregister an account. Keeps its profile folder unless --purge is given, and
 * --purge removes nothing while a session or the editor is using that folder.
 */
export function removeCommand(
  context: CliContext,
  name: string,
  options: RemoveOptions = {},
  leases: () => SessionLease[] = () => liveLeases(context.ctx),
): number {
  const standing = removalStanding(name, context.config, context.ctx, leases);
  if (!standing) {
    context.out(`account "${name}" not found`);
    return 1;
  }
  const { dir } = standing;

  const deregister = (): void => {
    removeAccount(name, context.ctx);
    if (getActive(context.ctx) === name) setActive(null, context.ctx);
  };

  if (options.purge) {
    const refusal = purgeRefusal(standing);
    if (refusal) {
      context.out(
        `"${name}" was not removed: ${refusal}. Run this again once nothing is using it, ` +
          'or without --purge to keep the folder.',
      );
      return 1;
    }
    // Never recursively delete a path outside the profiles tree, even if the
    // registry entry was crafted or a custom --dir escaped it.
    if (!standing.folderIsOurs) {
      try {
        clearCredential(dir);
      } catch {
        context.out(
          `could not clear credentials for "${name}" at ${dir}; account remains registered; retry --purge`,
        );
        return 1;
      }
      deregister();
      context.out(
        `deregistered "${name}", but did NOT purge ${dir} (outside ${profilesDir(context.config, context.ctx)}); delete it yourself if intended`,
      );
      return 0;
    }
    try {
      clearCredential(dir);
      rmSync(dir, { recursive: true, force: true });
    } catch {
      context.out(
        `could not fully purge "${name}" at ${dir}; account remains registered, but credentials or files may have been removed; retry --purge`,
      );
      return 1;
    }
    deregister();
    context.out(`removed "${name}" and purged ${dir}`);
  } else {
    deregister();
    context.out(`removed "${name}" (profile folder kept at ${dir})`);
  }
  return 0;
}
