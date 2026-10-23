/** Times and lengths of time as lending's messages say them. */

/** "2h 5m", "45m", "under a minute". */
export function durationWords(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'under a minute';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** When a token expires: "until 14:05 (2h 5m left)", or "expired at 14:05". */
export function expiryWords(expiresAt: number, now: number): string {
  if (expiresAt <= 0) return 'with no expiry recorded';
  const clock = new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return expiresAt > now
    ? `until ${clock} (${durationWords(expiresAt - now)} left)`
    : `expired at ${clock}`;
}

/**
 * A length of time as typed: "90m", "2h", "1h30m", "1d", "45s", or a bare
 * number of minutes. Milliseconds, or null when it is none of those.
 */
export function parseDuration(text: string): number | null {
  const typed = text.trim().toLowerCase();
  if (/^\d+$/.test(typed)) return Number(typed) * 60_000;
  const parts = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(typed);
  if (!parts || typed.length === 0) return null;
  const [days = 0, hours = 0, minutes = 0, seconds = 0] = parts
    .slice(1)
    .map((part) => Number(part ?? 0));
  return ((days * 24 + hours) * 60 + minutes) * 60_000 + seconds * 1000;
}
