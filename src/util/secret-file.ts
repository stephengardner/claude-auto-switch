import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * These helpers keep credential material and other sensitive files off other
 * users on a shared machine. On POSIX we set 0600 (files) / 0700 (dirs); on
 * Windows chmod is a no-op (the user profile ACL already restricts access), so
 * every call is best-effort and never throws on the chmod.
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

/** Write a file owner-only (0600). */
export function writeSecretFile(file: string, data: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, data, { encoding: 'utf8', mode: 0o600 });
  restrictPermissions(file, 0o600);
}

/** Copy a file and lock the destination to owner-only (0600). */
export function copySecretFile(src: string, dest: string): void {
  copyFileSync(src, dest);
  restrictPermissions(dest, 0o600);
}

/** Replace credential-shaped tokens with a redaction marker before logging output. */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, 'sk-ant-***REDACTED***')
    .replace(/\b[A-Za-z0-9_-]{60,}\b/g, '***REDACTED***');
}
