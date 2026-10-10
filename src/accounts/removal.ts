import path from 'node:path';
import { listAccounts } from './registry.js';
import { getActive } from '../state/active.js';
import { liveLeases, type SessionLease } from '../session/lease.js';
import { editorPointerAccount } from '../editor/junction.js';
import { activeLinkPath } from '../daemon/install.js';
import { readTarget } from '../daemon/junction.js';
import { configHome, profilesDir, type PathCtx } from '../config/paths.js';
import { isInside } from '../util/names.js';

/**
 * What removing an account would touch, read at the moment of asking.
 *
 * Removal has two readers: `ccx remove`, which acts on it, and the dashboard,
 * which has to say it before it asks. Both read it here, so the question the
 * dashboard shows and the rule the command enforces cannot drift apart.
 */
export interface RemovalStanding {
  name: string;
  dir: string;
  /**
   * Every lease a running session holds on it. A session moving off it is
   * still here until it lets go: it saves the old login back first.
   */
  leases: SessionLease[];
  /** It is the account new sessions start on. */
  active: boolean;
  /** No account is left once it is gone. */
  last: boolean;
  /** The editor reads its login straight from this folder. */
  editor: boolean;
  /** So does every Claude outside ccx, through the link `ccx daemon install` keeps. */
  daemon: boolean;
  /** Its folder is inside the profiles tree, the only place ccx deletes one. */
  folderIsOurs: boolean;
}

/** The standing of `name`, or null when there is no such account. */
export function removalStanding(
  name: string,
  config: { profilesDir?: string },
  c: PathCtx = {},
  leases: () => SessionLease[] = () => liveLeases(c),
): RemovalStanding | null {
  const accounts = listAccounts(c);
  const account = accounts.find((a) => a.name === name);
  if (!account) return null;
  const daemonTarget = readTarget(activeLinkPath(configHome(c)));
  return {
    name,
    dir: account.dir,
    leases: leases().filter((l) => l.account === name),
    active: getActive(c) === name,
    last: accounts.length === 1,
    editor: editorPointerAccount(accounts, c) === name,
    daemon: daemonTarget !== null && path.resolve(daemonTarget) === path.resolve(account.dir),
    folderIsOurs: isInside(profilesDir(config, c), account.dir),
  };
}

/** "a", "a and b", "a, b and c". */
function listed(parts: string[]): string {
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/**
 * Why the account's folder, and the login in it, cannot be deleted right now,
 * or null when it can.
 *
 * A running session saves its login back into the folder when the login is
 * renewed and when the session ends, creating the folder again if it is gone,
 * so a delete under it is undone. The editor and the daemon's link read the
 * folder directly, and would be left pointing at nothing.
 */
export function purgeRefusal(standing: RemovalStanding): string | null {
  const running = new Set(standing.leases.map((l) => l.pid)).size;
  const using = [
    ...(running === 1 ? ['1 session is running on it'] : []),
    ...(running > 1 ? [`${running} sessions are running on it`] : []),
    ...(standing.editor ? ['your editor is on it'] : []),
    ...(standing.daemon ? ["the daemon's link is on it"] : []),
  ];
  return using.length > 0 ? `its folder cannot be deleted while ${listed(using)}` : null;
}
