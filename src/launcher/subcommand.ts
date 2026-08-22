/**
 * Telling a claude SUBCOMMAND apart from a session.
 *
 * ccx exists to choose an account for a session. `claude update`, `claude mcp
 * list`, `claude stop <id>` and the rest are not sessions: they manage the
 * installation or its background sessions, and they take their own options.
 *
 * Routing them through the session path is not merely unnecessary, it breaks
 * them. That path adds `--session-id <uuid>` so a swap can resume the same
 * conversation, and a subcommand rejects it outright:
 *
 *     $ claude mcp list
 *     error: unknown option '--session-id'
 *     $ claude rc
 *     Error: Could not reach the server to look up session <uuid>.
 *
 * With the transparent shim installed every one of these goes through ccx, so
 * installing ccx quietly broke them. They pass straight through instead.
 */

/**
 * Every command the real CLI accepts, aliases included, since an alias is a
 * separate word to the parser.
 *
 * MANY OF THESE ARE UNDOCUMENTED. `claude --help` lists neither `rc` nor the
 * whole background-session family, and the CLI ships as a native binary, so
 * there is nothing to read the real list out of. Each was confirmed by running
 * `claude <name> --help` and getting that command's own usage back.
 *
 * That makes drift the expected failure, not a surprise: a command missing from
 * here is not a wrong answer, it is a broken command, found only when somebody
 * hits it. `subcommand.test.ts` closes what can be closed by checking this list
 * against a real CLI when one is present.
 */
export const SUBCOMMANDS = new Set([
  // Documented in `claude --help`.
  'agents',
  'auth',
  'auto-mode',
  'doctor',
  'gateway',
  'import',
  'install',
  'mcp',
  'plugin',
  'plugins',
  'project',
  'setup-token',
  'ultrareview',
  'update',
  'upgrade',
  // Undocumented. Remote Control, and `rc` is its alias.
  'remote-control',
  'rc',
  // Undocumented: managing background sessions. `kill` is an alias of `stop`.
  'attach',
  'kill',
  'logs',
  'respawn',
  'rm',
  'stop',
]);

/**
 * The subcommand these arguments invoke, or null when they are a session.
 *
 * Only the FIRST argument is considered, which is the whole trick. Reading past
 * a flag would mean knowing which flags take a value, and a table of flag
 * arities drifts out of date in silence: with one, `--model update` classifies
 * "update" as a command and a real session loses account rotation without a
 * word about it.
 *
 * So anything that does not begin with a command is a session. That is the safe
 * direction on purpose, because the two mistakes do not cost the same. Calling a
 * subcommand a session is the behaviour ccx has always had and shows up as a
 * loud error. Calling a session a subcommand silently drops the account
 * rotation that is the entire point of the tool.
 *
 * The cost is that `claude --verbose mcp list` stays on the session path. That
 * is rare, unchanged from before, and recoverable by dropping the flag.
 */
export function claudeSubcommandIn(args: readonly string[]): string | null {
  const first = args[0];
  return first !== undefined && SUBCOMMANDS.has(first) ? first : null;
}
