import { readFileSync } from 'node:fs';

/**
 * When the access token in a credential file expires, as epoch ms, or 0 when
 * the file is missing, unreadable, or carries no expiry.
 *
 * Zero rather than null so freshness comparisons stay plain arithmetic: an
 * unknown expiry loses to any known one, which is the safe direction (a copy
 * we cannot date is never treated as the newer one).
 */
export function readExpiresAt(credentialsFile: string): number {
  try {
    const parsed = JSON.parse(readFileSync(credentialsFile, 'utf8')) as {
      claudeAiOauth?: { expiresAt?: unknown };
    };
    const at = parsed.claudeAiOauth?.expiresAt;
    return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : 0;
  } catch {
    return 0;
  }
}
