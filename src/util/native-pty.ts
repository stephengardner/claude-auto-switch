import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as NodePty from 'node-pty';

/**
 * node-pty, ready to open a terminal on every platform.
 *
 * On Windows it is loaded from a copy of its own rather than from the install.
 * Windows will not replace a native file a process has loaded, and every ccx
 * session loads node-pty's for as long as it runs. Loaded from the install, it
 * made `npm install -g` fail until every session had been closed, so an update
 * could never reach a running session. Loaded from a copy kept per version
 * under the user's temp folder, the install is never held: an update lands
 * while sessions run, and they move to it on their own.
 *
 * On macOS, node-pty opens every terminal by running a small helper program,
 * spawn-helper, that it ships prebuilt, and its npm package ships that helper
 * without permission to run (node-pty 1.1.0; nothing in its install restores
 * it). Every terminal then failed to open with "posix_spawnp failed", so on a
 * fresh install `claude` did not start at all. The permission is restored here
 * before node-pty is used. Where the install cannot be changed (one owned by
 * root), node-pty is loaded from a copy of ccx's own, with the permission set.
 */

const requireHere = createRequire(import.meta.url);
let loaded: typeof NodePty | null = null;

export function nodePty(): typeof NodePty {
  if (loaded) return loaded;
  if (process.platform === 'win32') {
    try {
      loaded = requireHere(copyOfNodePty()) as typeof NodePty;
      return loaded;
    } catch {
      /* the install's own, as before: works, but holds the install while running */
    }
    loaded = requireHere('node-pty') as typeof NodePty;
    return loaded;
  }
  const installed = path.dirname(requireHere.resolve('node-pty/package.json'));
  if (!helpersRunnable(installed)) {
    try {
      const copy = copyOfNodePty();
      if (helpersRunnable(copy)) {
        loaded = requireHere(copy) as typeof NodePty;
        return loaded;
      }
    } catch {
      /* the install's own, which fails with node-pty's own message */
    }
  }
  loaded = requireHere('node-pty') as typeof NodePty;
  return loaded;
}

/** The file operations helpersRunnable needs, replaceable in tests. */
export interface ModeOps {
  statSync: (file: string) => { mode: number };
  chmodSync: (file: string, mode: number) => void;
}

/**
 * Make every spawn-helper node-pty may run under `dir` runnable by everyone:
 * whichever of its build folders node-pty loads from (a local build, or the
 * prebuilt one for this machine). False when one cannot be changed. True when
 * there is none, which is every platform but macOS.
 */
export function helpersRunnable(dir: string, ops: ModeOps = { statSync, chmodSync }): boolean {
  for (const folder of ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`]) {
    const helper = path.join(dir, folder, 'spawn-helper');
    if (!existsSync(helper)) continue;
    // Reading the mode is inside the guard too: a file gone between the two
    // calls must send the caller to its copy, not throw past it.
    try {
      const { mode } = ops.statSync(helper);
      if ((mode & 0o111) === 0o111) continue;
      ops.chmodSync(helper, (mode & 0o7777) | 0o111);
    } catch {
      return false;
    }
  }
  return true;
}

/** Make sure the copy for this node-pty version exists, and return its folder. */
export function copyOfNodePty(root = path.join(tmpdir(), 'claude-auto-switch-runtime')): string {
  const source = path.dirname(requireHere.resolve('node-pty/package.json'));
  const { version } = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8')) as {
    version: string;
  };
  const target = path.join(root, `node-pty-${version}-${process.platform}-${process.arch}`);
  if (existsSync(path.join(target, 'package.json'))) return target;
  // Built beside it and moved into place whole, so a session never loads half a copy.
  const temp = `${target}.${process.pid}.tmp`;
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  cpSync(path.join(source, 'lib'), path.join(temp, 'lib'), { recursive: true });
  for (const dir of ['build/Release', `prebuilds/${process.platform}-${process.arch}`]) {
    const from = path.join(source, dir);
    if (existsSync(from)) {
      cpSync(from, path.join(temp, dir), {
        recursive: true,
        filter: (file) => !file.endsWith('.pdb'),
      });
    }
  }
  cpSync(path.join(source, 'package.json'), path.join(temp, 'package.json'));
  try {
    renameSync(temp, target);
  } catch {
    // Another session placed it first; theirs is the same files.
    rmSync(temp, { recursive: true, force: true });
    if (!existsSync(path.join(target, 'package.json'))) throw new Error('no copy of node-pty');
  }
  return target;
}
