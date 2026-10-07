import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as NodePty from 'node-pty';

/**
 * node-pty, loaded on Windows from a copy of its own rather than from the
 * install.
 *
 * Windows will not replace a native file a process has loaded, and every ccx
 * session loads node-pty's for as long as it runs. Loaded from the install, it
 * made `npm install -g` fail until every session had been closed, so an update
 * could never reach a running session. Loaded from a copy kept per version
 * under the user's temp folder, the install is never held: an update lands
 * while sessions run, and they move to it on their own. Elsewhere a loaded
 * file can be replaced, so the install is used directly.
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
  }
  loaded = requireHere('node-pty') as typeof NodePty;
  return loaded;
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
