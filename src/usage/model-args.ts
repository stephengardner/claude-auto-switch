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
 * Both spellings a command line can use for this flag. `--model=fable` and
 * `--model fable` mean the same thing to the parser, so anything that removes
 * one has to remove the other, or the spent model survives and wins.
 *
 * `--fallback-model` is deliberately NOT matched: it is a different setting,
 * it belongs to the operator, and it is not the flag being rotated.
 */
const MODEL_FLAG = '--model';
const MODEL_EQUALS = '--model=';

/**
 * A model name never starts with `-`, so a token that does is the NEXT option,
 * not this flag's value. Swallowing it would quietly drop something like
 * `--continue` and change what the session does.
 */
function isValue(token: string | undefined): token is string {
  return typeof token === 'string' && token.length > 0 && !token.startsWith('-');
}

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
    const arg = args[i] as string;
    if (arg === MODEL_FLAG) {
      if (isValue(args[i + 1])) i += 1; // drop its value too, but only if it HAS one
      continue;
    }
    if (arg.startsWith(MODEL_EQUALS)) continue;
    out.push(arg);
  }
  out.push(MODEL_FLAG, model);
  return out;
}

/** The value of `--model` in `args`, in either spelling, or null when absent. */
export function modelInArgs(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === MODEL_FLAG) {
      const next = args[i + 1];
      return isValue(next) ? next : null;
    }
    if (arg.startsWith(MODEL_EQUALS)) {
      // Same test as the spaced form, so one spelling cannot accept a value the
      // other rejects and get mistaken for a real pin.
      const value = arg.slice(MODEL_EQUALS.length);
      return isValue(value) ? value : null;
    }
  }
  return null;
}
