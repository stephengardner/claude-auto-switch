import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/**
 * Replace a file in one step, so a reader never sees half of it.
 *
 * Writing in place truncates first, which leaves a window where the file is
 * empty or partial. Anything reading it then gets nothing and falls back, and
 * these files exist precisely to stop ccx falling back to a worse answer: the
 * settings ccx must not damage, and the report saying which model a session is
 * actually running. Both are written far more often than they are read, so that
 * window is not theoretical.
 *
 * A complete temporary file beside the target, flushed, then renamed over the
 * top: the file is either the old one or the new one at every instant.
 */

let counter = 0;

export function writeFileAtomic(file: string, contents: string): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(file)}.ccx-${process.pid}-${counter++}.tmp`);
  try {
    const handle = openSync(temp, 'w');
    try {
      // writeFileSync on a descriptor, NOT a bare writeSync: a single write can
      // put fewer bytes on disk than it was given, and ignoring that return
      // value means fsyncing and renaming a truncated file, which publishes
      // damage atomically instead of preventing it. This loops until the whole
      // buffer is out. Encoded once, so the byte count is not in question.
      writeFileSync(handle, Buffer.from(contents, 'utf8'));
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temp, file);
  } catch (error) {
    // The original survived; a stray temp file beside it should not.
    rmSync(temp, { force: true });
    throw error;
  }
}
