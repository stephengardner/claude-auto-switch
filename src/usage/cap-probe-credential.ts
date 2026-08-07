import path from 'node:path';

/**
 * Which credential file answers "is this account out of room?"
 *
 * The account's own, always. It reads like a detail and it is not: getting it
 * wrong caps healthy accounts.
 *
 * The check used to ask the SESSION credential, for freshness. But the session
 * directory is shared between concurrent ccx runs, so it holds whichever account
 * another run installed last. With two runs rotating at the same time, an
 * exhausted account's token answered on behalf of a healthy one, and the healthy
 * one took the cap. Measured on a real ledger: five accounts were capped for
 * five hours each inside 87 seconds, including one with 97% of its five-hour
 * window still free, which then refused to start anything at all.
 *
 * Freshness buys nothing here. Usage belongs to the ACCOUNT, so an older token
 * for the right account gives the right answer, while the newest token for the
 * wrong account gives a confident wrong one.
 */
export function capProbeCredential(
  accountDir: string | null | undefined,
  sessionCredentials: string,
  credentialFileName = '.credentials.json',
): string {
  // Only before an account has been chosen, which is before anything can be
  // capped, so there is no wrong account to answer for yet.
  if (!accountDir) return sessionCredentials;
  return path.join(accountDir, credentialFileName);
}
