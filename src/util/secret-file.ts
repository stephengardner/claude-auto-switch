import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * These helpers keep credential material and other sensitive files off other
 * users on a shared machine. On POSIX we set 0600 (files) / 0700 (dirs); on
 * Windows chmod is a no-op (the user profile ACL already restricts access), so
 * every call is best-effort and never throws on the chmod.
 *
 * Writes are ATOMIC (write a temp file in the same directory, then rename over
 * the target). A credential file half-written by a crash or a killed process is
 * a login destroyed, so partial writes must never be observable.
 */

/** chmod a path to owner-only, ignoring failure (Windows/unsupported FS). */
export function restrictPermissions(target: string, mode: number): void {
  try {
    chmodSync(target, mode);
  } catch {
    /* not supported on this platform/filesystem */
  }
}

/** Create a directory owner-only (0700). */
export function secureMkdir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictPermissions(dir, 0o700);
}

/** Atomically write bytes owner-only: temp file in the same dir, then rename. */
function writeSecretBytes(file: string, data: string | Buffer): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Same directory keeps the rename on one filesystem, which is what makes it
  // atomic; the pid/time suffix keeps concurrent writers from colliding.
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    restrictPermissions(tmp, 0o600);
    renameSync(tmp, file);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* temp cleanup is best effort */
    }
    throw err;
  }
  restrictPermissions(file, 0o600);
}

/** Write a file owner-only (0600), atomically. */
export function writeSecretFile(file: string, data: string): void {
  writeSecretBytes(file, data);
}

/** Copy a file owner-only (0600), atomically (never a half-copied credential). */
export function copySecretFile(src: string, dest: string): void {
  try {
    writeSecretBytes(dest, readFileSync(src));
  } catch (err) {
    // Fall back to a plain copy only if the atomic path is unavailable (e.g. a
    // filesystem that rejects the rename); still better than failing the swap.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
    copyFileSync(src, dest);
    restrictPermissions(dest, 0o600);
  }
}

/** Replace credential-shaped tokens with a redaction marker before logging output. */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, 'sk-ant-***REDACTED***')
    .replace(/\b[A-Za-z0-9_-]{60,}\b/g, '***REDACTED***');
}
