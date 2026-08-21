/**
 * Where to start when every account looks out of room.
 *
 * ccx exists to keep you working across limits. The one thing it must never do
 * is become the reason you cannot start Claude at all, and that is exactly what
 * it did: with every account recorded as week-spent it refused to launch, so
 * `claude` did nothing and the only output was "every account has hit its
 * limit". The operator had usage the whole time.
 *
 * ccx is not the authority on whether a request will be served, and it is wrong
 * in more ways than it can enumerate:
 *
 *   - usage credits carry an account past its plan limit, and a cached snapshot
 *     knows nothing about them
 *   - a cap can have been recorded against the wrong account
 *   - a window can reset earlier than the reset time we stored
 *   - a plan can change under us
 *
 * Every one of those ends with ccx refusing work the server would have done. So
 * when there is any account left with a login, we start on it, say plainly why,
 * and let the server give the answer. Refusing is reserved for the case where
 * there is genuinely nothing to launch: no account with a usable login.
 */

export interface StartCandidate {
  name: string;
  dir: string;
}

export interface LastResortInput {
  /** Accounts that could be started, in the order rotation would try them. */
  usable: StartCandidate[];
  /** Preferred when it can still run, so the session stays where it was. */
  active?: string | null;
  /** Set only when every active limit is about ONE model. */
  modelOnly?: { model: string; resetsAt: number | null } | null;
  /** Injected so the message is stable in tests. */
  formatTime?: (epochMs: number) => string;
}

export interface LastResortStart {
  account: StartCandidate;
  message: string;
}

/**
 * The account to start on anyway, and what to tell the operator, or null when
 * there is nothing at all to start.
 */
export function lastResortStart(input: LastResortInput): LastResortStart | null {
  const account = input.usable.find((a) => a.name === input.active) ?? input.usable[0];
  // Nothing with a working login. This is the ONLY honest refusal, and the
  // caller's ending already explains which accounts need signing in.
  if (!account) return null;

  if (input.modelOnly) {
    const format = input.formatTime ?? ((t: number) => new Date(t).toLocaleString());
    const when = input.modelOnly.resetsAt ? ` It frees up ${format(input.modelOnly.resetsAt)}.` : '';
    return {
      account,
      message:
        `every account is out of ${input.modelOnly.model}, but nothing else is limited.` +
        `${when} Starting on "${account.name}" anyway: switch models with /model to keep working.`,
    };
  }

  return {
    account,
    message:
      'every account looks out of room, but that is a cached judgement and it can be wrong ' +
      '(usage credits, a limit recorded against the wrong account, a window that has since ' +
      `reset). Starting on "${account.name}" anyway and letting the server decide.`,
  };
}
