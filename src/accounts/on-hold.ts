/**
 * Whether the token endpoint's refusal says the account is on hold, as it did
 * for a restricted account: invalid_grant, "account_on_hold", and a link to
 * claude.ai/restricted. Signing in again does not fix that, which is why it is
 * told apart from an ordinary sign-out.
 *
 * On its own so the credential log can name the reason for a record without
 * loading what checks a login (accounts/login-check re-exports it).
 */
export function isOnHold(detail: string | undefined): boolean {
  return !!detail && /account_on_hold|claude\.ai\/restricted/i.test(detail);
}
