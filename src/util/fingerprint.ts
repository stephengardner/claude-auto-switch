import { createHash } from 'node:crypto';

/**
 * A short, comparable fingerprint of a secret, so secrets can be compared and
 * logged about without ever being written down.
 *
 * Shared because two places compare credentials this way, and two copies of a
 * hash rule can drift apart silently: change the algorithm or the length in one
 * and the two stop agreeing, with nothing failing to say so.
 */
export function sha256Fingerprint(value: string, length = 16): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}
