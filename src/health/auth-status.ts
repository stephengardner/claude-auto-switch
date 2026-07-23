import { AuthStatusParseError } from '../util/errors.js';

/** Normalized account health derived from `claude auth status` output. */
export interface Health {
  loggedIn: boolean;
  email?: string;
  orgName?: string;
  plan?: string;
}

/**
 * Parse `claude auth status` stdout into a Health object. The JSON `loggedIn`
 * field is the source of truth (spec 6.3). Tolerates a warning line printed
 * before or after the JSON; throws AuthStatusParseError on anything unparseable.
 */
export function parseAuthStatus(stdout: string): Health {
  const json = extractJsonObject(stdout);
  if (json === undefined) {
    throw new AuthStatusParseError(
      `no JSON object found in auth status output: ${truncate(stdout)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new AuthStatusParseError(`auth status output was not valid JSON: ${(err as Error).message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new AuthStatusParseError('auth status output was not a JSON object');
  }

  const loggedIn = parsed.loggedIn;
  if (typeof loggedIn !== 'boolean') {
    throw new AuthStatusParseError('auth status JSON is missing the boolean "loggedIn" field');
  }

  const health: Health = { loggedIn };
  const { email, orgName, subscriptionType } = parsed;
  if (typeof email === 'string') health.email = email;
  if (typeof orgName === 'string') health.orgName = orgName;
  if (typeof subscriptionType === 'string') health.plan = subscriptionType;
  return health;
}

/** Slice from the first `{` to the last `}`, tolerating surrounding log noise. */
function extractJsonObject(s: string): string | undefined {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return undefined;
  return s.slice(start, end + 1);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function truncate(s: string, n = 120): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}
