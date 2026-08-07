import { capProbeCredential } from './cap-probe-credential.js';
import { probeLimit, type LimitProbeResult } from './limit-probe.js';

/**
 * Deciding whether limit-looking text has actually earned a cap, and how wide.
 *
 * Writing a cap is expensive to get wrong: an account-wide cap takes an account
 * out of rotation for hours, and enough of them make ccx refuse to start at all.
 * So the bar is evidence, and the evidence has to be about the RIGHT account.
 *
 * Two ways this went wrong in production, both on the same day:
 *
 *   The interactive path asked the SHARED session credential, so with two runs
 *   rotating at once an exhausted account answered for a healthy one. Five
 *   accounts were capped inside 87 seconds, one of them with 97% of its
 *   five-hour window still free.
 *
 *   The headless path asked nothing at all. Any output matching the cap patterns
 *   became an account-wide cap, so a Fable-only limit took the whole account out
 *   even though it still ran on every other model.
 *
 * The scope matters as much as the verdict: a model-scoped cap leaves the
 * account usable on other models, which is the difference between "switch to
 * Opus and carry on" and "everything is capped, come back in five hours".
 */

export interface CapDecision {
  /** Write a cap only when this is true. */
  limited: boolean;
  /** Set when ONE model is out. The account still works on the others. */
  model?: string;
  /** When the window that is actually spent comes back. */
  resetAt?: number;
  /** For the log, so a refusal can be understood after the fact. */
  detail?: string;
}

export interface ConfirmCapDeps {
  /** Injected in tests; the real one is a plain GET that costs no tokens. */
  probe?: (credentialsFile: string, renderedText: string) => Promise<LimitProbeResult>;
  /** Used only before an account is chosen, when nothing can be capped yet. */
  sessionCredentials?: string;
}

/**
 * Ask the account's own credential whether it is really out, and how widely.
 *
 * Refuses on anything short of a confirmed limit. An unreachable endpoint, a
 * missing token, a 429: all of those mean "not proven", and not proven must
 * never become a cap. A session that keeps hitting a real limit will trigger
 * this again; a healthy account wrongly capped stays broken for hours.
 */
export async function confirmCap(
  accountDir: string | null | undefined,
  renderedText: string,
  deps: ConfirmCapDeps = {},
): Promise<CapDecision> {
  const probe = deps.probe ?? probeLimit;
  const credentials = capProbeCredential(accountDir, deps.sessionCredentials ?? '');
  if (!credentials) return { limited: false, detail: 'no credential to ask' };

  const result = await probe(credentials, renderedText);
  if (result.verdict !== 'limited') {
    return { limited: false, detail: result.detail ?? result.verdict };
  }

  // A named model means only that model is gone. Carried through so the cap is
  // recorded WITH its scope; dropping it here is what turned "Fable is spent"
  // into "this account is unusable".
  if (result.limitedModel) {
    const window = (result.models ?? []).find((m) => m.name === result.limitedModel);
    return {
      limited: true,
      model: result.limitedModel,
      ...(window?.resetsAt !== undefined ? { resetAt: window.resetsAt } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
    };
  }

  // Account-wide. Reset time from whichever window is actually spent, so it
  // comes back the moment it can rather than after a fixed guess.
  const fiveOut = typeof result.fiveHour === 'number' && result.fiveHour >= 1;
  const resetAt = fiveOut ? result.fiveHourReset : result.sevenDayReset;
  return {
    limited: true,
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(result.detail ? { detail: result.detail } : {}),
  };
}
