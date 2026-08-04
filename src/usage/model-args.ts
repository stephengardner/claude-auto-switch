/**
 * Putting the chosen model onto the command line for the next session.
 *
 * Choosing a model and then not applying it is worse than not choosing one: the
 * session keeps running the model that just ran out, while the operator has been
 * told it moved. So the decision has to reach the process that is started.
 *
 * `--model` is used rather than rewriting the session's settings file, because
 * the settings file is shared across accounts and a rotation should not quietly
 * repin someone's editor. The flag lasts exactly as long as the session it
 * starts, which is the right lifetime for a decision made about one rotation.
 */

/**
 * Return `args` with `--model` set to `model`, replacing any value already there.
 *
 * Replacing rather than appending matters: an explicit `--model fable` is
 * precisely the case where Fable might be exhausted, and appending would leave
 * the first (spent) value winning, or hand the process two conflicting flags.
 */
export function withModel(args: string[], model: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--model') {
      i += 1; // drop the value that followed it too
      continue;
    }
    out.push(args[i] as string);
  }
  out.push('--model', model);
  return out;
}

/** The value of `--model` in `args`, or null when it is not there. */
export function modelInArgs(args: string[]): string | null {
  const at = args.indexOf('--model');
  const value = at === -1 ? undefined : args[at + 1];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
