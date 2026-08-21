import fs from 'node:fs';
import path from 'node:path';

export interface JunctionOps {
  platform?: NodeJS.Platform;
}

/** True if the path exists and is a symlink/junction (not a real directory). */
export function isLink(linkPath: string): boolean {
  try {
    return fs.lstatSync(linkPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The raw target the link points at, or null. */
export function readTarget(linkPath: string): string | null {
  try {
    return fs.readlinkSync(linkPath);
  } catch {
    return null;
  }
}

function removeLink(linkPath: string): void {
  try {
    fs.unlinkSync(linkPath);
  } catch {
    try {
      fs.rmdirSync(linkPath);
    } catch {
      /* nothing to remove */
    }
  }
}

/**
 * Point `linkPath` at `targetDir`, creating or atomically re-pointing the link.
 * Uses a Windows junction (no admin needed) or a POSIX directory symlink.
 * Refuses to touch `linkPath` if it exists as a REAL directory, so it can never
 * clobber a real config folder.
 */
export function setTarget(linkPath: string, targetDir: string, ops: JunctionOps = {}): void {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(linkPath);
  } catch {
    stat = null;
  }
  if (stat && !stat.isSymbolicLink()) {
    // An EMPTY directory holds nothing that could be lost, and refusing on one
    // is not protection, it is an outage: a left-behind empty "editor-active"
    // folder made setup throw a stack trace and stop, after the shell shim and
    // status line had already been installed. Anything with contents, or a real
    // file, is still refused, because that could be a real config folder.
    if (!(stat.isDirectory() && isEmptyDirectory(linkPath))) {
      throw new Error(`refusing to replace non-link path: ${linkPath}`);
    }
    fs.rmdirSync(linkPath);
  }

  const platform = ops.platform ?? process.platform;
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  removeLink(linkPath);
  fs.symlinkSync(targetDir, linkPath, platform === 'win32' ? 'junction' : 'dir');
}

/** Remove the link if it is one. Refuses to remove a real directory. */
export function removeTarget(linkPath: string): void {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(linkPath);
  } catch {
    return;
  }
  if (!stat.isSymbolicLink()) {
    throw new Error(`refusing to remove non-link path: ${linkPath}`);
  }
  removeLink(linkPath);
}

/** True only when the path is a directory with no entries at all. */
function isEmptyDirectory(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}
