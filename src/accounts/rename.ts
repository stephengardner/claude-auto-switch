import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { loadRegistry, saveRegistry } from './registry.js';
import { RegistryError } from '../util/errors.js';
import { getActive, setActive } from '../state/active.js';
import { loadLedger, saveLedger } from '../ledger/ledger.js';
import { readUsageSnapshot, writeUsageSnapshot } from '../usage/usage-store.js';
import { assertProfileName } from '../util/names.js';
import { leaseFor } from '../session/lease.js';
import { profilesDir } from '../config/paths.js';
import type { PathCtx } from '../config/paths.js';

/**
 * Renaming an account.
 *
 * The name is used as a key in more than one place, so a rename that only edits
 * the registry leaves the account's limit history and usage numbers behind under
 * the old name, which reads as "my usage reset itself". Everything keyed by name
 * moves together here.
 *
 * The profile FOLDER is moved too when it is safe: a folder still named after the
 * old account is exactly the confusing mismatch that makes these profiles hard to
 * reason about. It is left alone (and said so) when a session is using it, when it
 * lives somewhere custom, or when the destination already exists, because none of
 * those can be moved without risking a running session or someone's data.
 */

export interface RenameResult {
  from: string;
  to: string;
  /** True when the profile folder moved along with the name. */
  folderMoved: boolean;
  /** Why the folder stayed where it was, when it did. */
  folderNote?: string;
}

export interface RenameDeps {
  /** Injected in tests, to exercise the failure that moves a folder then cannot record it. */
  saveRegistry?: typeof saveRegistry;
}

export function renameAccount(
  from: string,
  to: string,
  config: { profilesDir?: string },
  c: PathCtx = {},
  deps: RenameDeps = {},
): RenameResult {
  const persist = deps.saveRegistry ?? saveRegistry;
  const target = to.trim();
  assertProfileName(target);
  if (target === from) throw new RegistryError(`"${from}" already has that name`);

  const registry = loadRegistry(c);
  const account = registry.accounts.find((a) => a.name === from);
  if (!account) throw new RegistryError(`account "${from}" not found`);
  if (registry.accounts.some((a) => a.name === target)) {
    throw new RegistryError(`an account called "${target}" already exists`);
  }

  // Move the folder first: if it fails, nothing has been renamed yet, so there is
  // no half-renamed account whose registry entry points at a folder that moved.
  const homeOfProfiles = profilesDir(config, c);
  const expected = path.join(homeOfProfiles, from);
  const destination = path.join(homeOfProfiles, target);
  let folderMoved = false;
  let folderNote: string | undefined;

  if (path.resolve(account.dir) !== path.resolve(expected)) {
    folderNote = 'its folder is in a custom location, so it kept its path';
  } else if (leaseFor(from, c)) {
    folderNote = 'a session is using it, so its folder kept the old name';
  } else if (existsSync(destination)) {
    folderNote = `a folder called "${target}" already exists, so the old one kept its name`;
  } else {
    try {
      renameSync(account.dir, destination);
      folderMoved = true;
    } catch (err) {
      folderNote = `its folder could not be moved (${(err as Error).message}), so it kept the old name`;
    }
  }

  const originalDir = account.dir;
  account.name = target;
  if (folderMoved) account.dir = destination;
  try {
    persist(registry, c);
  } catch (err) {
    // The folder moved but the registry did not. Left alone, the account would
    // still be recorded under its old name pointing at a folder that no longer
    // exists, so its login would look lost. Put the folder back.
    if (folderMoved) {
      try {
        renameSync(destination, originalDir);
      } catch {
        /* nothing better to do; the original failure is the one worth reporting */
      }
    }
    throw err;
  }

  // Everything else keyed by the name. Done after the registry write so a failure
  // here leaves a renamed account rather than an unrenamed one with moved history.
  if (getActive(c) === from) setActive(target, c);

  const ledger = loadLedger(c);
  let ledgerChanged = false;
  for (const cap of ledger.caps) {
    if (cap.account === from) {
      cap.account = target;
      ledgerChanged = true;
    }
  }
  if (ledgerChanged) saveLedger(ledger, c);

  const usage = readUsageSnapshot(c);
  const entry = usage.accounts[from];
  if (entry) {
    usage.accounts[target] = entry;
    delete usage.accounts[from];
    writeUsageSnapshot(usage, c);
  }

  return { from, to: target, folderMoved, ...(folderNote ? { folderNote } : {}) };
}
