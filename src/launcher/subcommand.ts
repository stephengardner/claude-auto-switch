/**
 * Telling a claude SUBCOMMAND apart from a session.
 *
 * ccx exists to choose an account for a session. `claude update`, `claude mcp
 * list` and the rest are not sessions: they manage the installation or its
 * configuration, and they take their own options.
 *
 * Routing them through the session path is not merely unnecessary, it breaks
 * them. That path adds `--session-id <uuid>` so a swap can resume the same
 * conversation, and a subcommand rejects it outright:
 *
 *     $ claude mcp list
 *     error: unknown option '--session-id'
 *
 * With the transparent shim installed, every one of these goes through ccx, so
 * installing ccx quietly broke `claude update` for the operator. They pass
 * straight through instead, unmodified.
 */

/**
 * The subcommands the real CLI defines, including the aliases, which are
 * separate words to the parser.
 *
 * NOT every entry here appears in `claude --help`. `rc` (Remote Control) is
 * hidden and was found only by running it, after it had already been reported
 * broken. The CLI ships as a native binary, so the full list cannot be read out
 * of it; this is best effort, and `subcommand.test.ts` guards the half that can
 * be checked by asserting every DOCUMENTED command appears here.
 */
export const SUBCOMMANDS = new Set([
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
  // Remote Control. Absent from `claude --help`, so it can only be known by
  // having been told: through the session path it became
  // "Could not reach the server to look up session <uuid>".
  'rc',
  'setup-token',
  'ultrareview',
  'update',
  'upgrade',
]);

/**
 * The subcommand these arguments invoke, or null when they are a session.
 *
 * The FIRST bare word decides, and if it is not a subcommand the answer is null
 * rather than "keep looking". That is what keeps a prompt from being mistaken
 * for one: `claude fix the update script` has to stay a session, and it does,
 * because "fix" settles it. Flags are skipped so that a value belonging to one
 * (`--model opus`) is never read as the word that decides.
 */
export function claudeSubcommandIn(args: readonly string[]): string | null {
  for (const arg of args) {
    // Everything after `--` is an argument, never a command.
    if (arg === '--') return null;
    if (arg.startsWith('-')) continue;
    return SUBCOMMANDS.has(arg) ? arg : null;
  }
  return null;
}
