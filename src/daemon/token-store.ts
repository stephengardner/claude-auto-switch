import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const FILENAME = 'oauth-token';

export function tokenPath(accountDir: string): string {
  return path.join(accountDir, FILENAME);
}

/** Store an account's long-lived OAuth token (mode 0600 where the OS supports it). */
export function saveToken(accountDir: string, token: string): void {
  mkdirSync(accountDir, { recursive: true });
  const file = tokenPath(accountDir);
  writeFileSync(file, `${token.trim()}\n`, 'utf8');
  try {
    chmodSync(file, 0o600);
  } catch {
    /* file mode not supported (Windows) */
  }
}

/** Read an account's stored OAuth token, or null if absent/empty. */
export function readToken(accountDir: string): string | null {
  const file = tokenPath(accountDir);
  if (!existsSync(file)) return null;
  const token = readFileSync(file, 'utf8').trim();
  return token.length > 0 ? token : null;
}

/**
 * Extract the OAuth token from `claude setup-token` output. Claude subscription
 * tokens look like `sk-ant-...`; otherwise fall back to the longest
 * credential-shaped token in the output.
 */
export function extractToken(output: string): string | null {
  const prefixed = output.match(/sk-ant-[A-Za-z0-9_-]{20,}/);
  if (prefixed) return prefixed[0];
  const candidates = output
    .split(/\s+/)
    .filter((t) => /^[A-Za-z0-9_.-]{40,}$/.test(t))
    .sort((a, b) => b.length - a.length);
  return candidates[0] ?? null;
}
