import { sessionIdentityEmail } from '../accounts/credential-vault.js';

/**
 * Who a session ACTUALLY is, versus who ccx believes it is.
 *
 * These can differ, and when they do every downstream decision that assumes
 * they match goes wrong in the same direction: the session shows account X's
 * limit banner while ccx asks account Y whether it is out of room, gets "no",
 * and refuses to switch, forever. That exact loop ran for hours here: a session
 * forced through /login came back as whatever account the browser picked, and
 * from then on the believed account answered questions about the actual one.
 *
 * So the two identities are resolved TOGETHER, in one place, and a mismatch is
 * a first-class answer rather than something each call site rediscovers. The
 * believed side is compared by the address recorded when the account was
 * REGISTERED, which does not drift; a profile's own config file can already be
 * wrong by the time it is read.
 *
 * Unknown never accuses: a session or account with no recorded identity is not
 * evidence of a mismatch, and guessing one would take healthy accounts out of
 * rotation on someone else's limit, which is the expensive direction.
 */

export interface RegisteredAccount {
  name: string;
  dir: string;
  /** The address recorded at registration; absent for pre-registration profiles. */
  email?: string;
}

export interface SessionIdentity {
  /** The address the session dir is signed in as right now, or null. */
  email: string | null;
  /** The registered account that address resolves to, or null when none match. */
  actual: RegisteredAccount | null;
  /** The account ccx believes the session is running as. */
  believed: RegisteredAccount | null;
  /** Both sides known, and different: the session is not who ccx thinks it is. */
  mismatch: boolean;
}

export interface ResolveDeps {
  /** Injected in tests; the real one reads .claude.json beside the login. */
  readEmail?: (dir: string) => string | null;
}

export function resolveSessionIdentity(
  input: {
    sessionDir: string;
    believed: RegisteredAccount | null;
    accounts: RegisteredAccount[];
  },
  deps: ResolveDeps = {},
): SessionIdentity {
  const readEmail = deps.readEmail ?? sessionIdentityEmail;
  const email = readEmail(input.sessionDir);
  const lower = email?.trim().toLowerCase() ?? null;

  const actual =
    lower === null
      ? null
      : (input.accounts.find((a) => a.email && a.email.trim().toLowerCase() === lower) ?? null);

  return {
    email,
    actual,
    believed: input.believed,
    mismatch: decideMismatch(lower, actual, input.believed),
  };
}

function decideMismatch(
  sessionEmail: string | null,
  actual: RegisteredAccount | null,
  believed: RegisteredAccount | null,
): boolean {
  // Nothing to compare on one side or the other: not a mismatch, an unknown.
  if (!sessionEmail || !believed) return false;
  // The registered address is the trustworthy comparison when it exists.
  if (believed.email) return believed.email.trim().toLowerCase() !== sessionEmail;
  // The believed account never had an address recorded. The session resolving
  // to a DIFFERENT registered account is still positive evidence; resolving to
  // nothing is not.
  return actual !== null && actual.name !== believed.name;
}
