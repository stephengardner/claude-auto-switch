/**
 * Reading and removing the "resume the last conversation" flag.
 *
 * This lives on its own because two different places need to agree about it:
 * the launcher decides whether to WATCH for "no conversation found", and the
 * retry after that message has to produce a genuinely fresh command line. When
 * the retry kept the flag, "starting fresh" just repeated the failed resume.
 */

const CONTINUE_FLAGS = new Set(['--continue', '-c']);

/** Whether `args` asks to resume the last conversation. */
export function wantsContinue(args: string[]): boolean {
  return args.some((a) => CONTINUE_FLAGS.has(a));
}

/**
 * Return `args` with every resume flag removed, in either spelling.
 *
 * Used for the retry after a resume finds nothing: the operator may have typed
 * `--continue` themselves, and leaving it in means the "fresh" session is not
 * fresh at all.
 */
export function withoutContinue(args: string[]): string[] {
  return args.filter((a) => !CONTINUE_FLAGS.has(a));
}
