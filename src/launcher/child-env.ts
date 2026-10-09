/**
 * The environment a Claude that ccx starts is given.
 *
 * Claude reads its login from the environment before it reads the session
 * folder: `CLAUDE_CODE_OAUTH_TOKEN` wins over the credential ccx installed.
 * So a variable inherited from wherever ccx was started can put a session on
 * an account ccx does not know it is on, and then everything ccx believes
 * about that session is wrong: which account its usage is spent from, which
 * account a refused turn is blamed on, and where other sessions spread to.
 */

/**
 * Variables a Claude host sets for its OWN child processes: Claude Desktop for
 * the Claude it runs, and Claude for the hooks and tools it runs. A brand-new
 * top-level session must not inherit them. `CLAUDECODE` alone makes Claude
 * refuse to start, taking itself for a session nested inside another; the rest
 * tie it to a host that is not there (a messaging socket, a session id, an
 * account Desktop chose) or change how it behaves.
 */
export const HOST_ONLY_ENV: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_PID',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_EFFORT',
  'CLAUDE_ENV_FILE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_NAME',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_ACCOUNT_UUID',
  'CLAUDE_CODE_ORGANIZATION_UUID',
  'CLAUDE_CODE_RATE_LIMIT_TIER',
  'CLAUDE_CODE_SUBSCRIPTION_TYPE',
  'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_SDK_READS_SESSION_STATE',
  'CLAUDE_CODE_DESKTOP_APP_VERSION',
  'CLAUDE_CODE_TERMINAL_MCP_TOOLS',
  'CLAUDE_CODE_DISABLE_TERMINAL_TITLE',
  'CLAUDE_AGENT_SDK_VERSION',
];

/**
 * The variables that decide which account a Claude runs as. ccx alone decides
 * that for the sessions it starts, and sets the token itself for an account
 * that has one (`ccx token`). The rest of a person's environment is theirs and
 * reaches the session as it is.
 */
export const ACCOUNT_ENV: readonly string[] = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_ACCOUNT_UUID',
  'CLAUDE_CODE_ORGANIZATION_UUID',
  'CLAUDE_CODE_RATE_LIMIT_TIER',
  'CLAUDE_CODE_SUBSCRIPTION_TYPE',
  'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
];

/** `env` without the named variables, as a plain string map. */
export function withoutEnv(env: NodeJS.ProcessEnv, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  // Case-insensitive, because Windows environment names are.
  const drop = new Set(names.map((n) => n.toUpperCase()));
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !drop.has(key.toUpperCase())) out[key] = value;
  }
  return out;
}

/** `env` without the host-only variables: for a session that is new and top level. */
export function scrubHostEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return withoutEnv(env, HOST_ONLY_ENV);
}
