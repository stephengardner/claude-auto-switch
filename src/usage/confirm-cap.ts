import path from 'node:path';
import { capProbeCredential } from './cap-probe-credential.js';
import { isUsableCredential, CREDENTIALS_FILE } from '../accounts/credential-vault.js';
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
  return decideFromProbe(await probe(credentials, renderedText));
}

/** A cap decision that also says WHOSE credential answered. */
export interface SessionCapDecision extends CapDecision {
  askedOf: 'session' | 'profile';
}

/**
 * Confirm a limit for an INTERACTIVE session, asking the session's own login.
 *
 * The old rule here was the profile's credential, "the account we are about to
 * cap", written when every session shared one directory and the session
 * credential could belong to any concurrent run. One directory per session
 * inverted that: the session's login is now exactly the identity that rendered
 * the limit banner on screen, and the profile is the guess. Asking the profile
 * is how a session signed in as somebody else (a mid-session /login) deadlocked
 * for hours: the actual account's banner on screen, the believed account
 * answering "not capped", and the switch never came.
 *
 * The caller resolves WHO the session credential belongs to (session-identity)
 * and records the cap against that account. This function only answers "is the
 * login this session is running on out of room, and how widely".
 *
 * Falls back to the believed profile when the session has no usable login of
 * its own, which is the one case where the profile is the better guess.
 */
export async function confirmSessionCap(
  input: { sessionDir: string; believedDir: string | null },
  renderedText: string,
  deps: ConfirmCapDeps = {},
): Promise<SessionCapDecision> {
  const probe = deps.probe ?? probeLimit;
  const sessionCredentials = path.join(input.sessionDir, CREDENTIALS_FILE);
  const askedOf: 'session' | 'profile' = isUsableCredential(sessionCredentials)
    ? 'session'
    : 'profile';
  const credentials =
    askedOf === 'session'
      ? sessionCredentials
      : input.believedDir
        ? path.join(input.believedDir, CREDENTIALS_FILE)
        : null;
  if (!credentials) return { limited: false, detail: 'no credential to ask', askedOf };
  return { ...decideFromProbe(await probe(credentials, renderedText)), askedOf };
}

function decideFromProbe(result: LimitProbeResult): CapDecision {
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

  // An account-wide cap takes the WHOLE account out for hours, so it has to be
  // earned by an account-wide window that is genuinely spent. This branch used
  // to be reached by assumption: any "limited" verdict that did not name a
  // model became account-wide. That locked out an account with 2% of its
  // five-hour window used and 57% of its week left, because its Fable was gone.
  const accountWindow = spentAccountWindow(result);
  if (accountWindow) {
    return { limited: true, ...accountWindow, ...(result.detail ? { detail: result.detail } : {}) };
  }

  // Nothing account-wide is spent, so a spent model is the whole story, and the
  // account keeps working on everything else.
  const model = spentModelWindow(result);
  if (model) {
    return {
      limited: true,
      model: model.name,
      ...(model.resetsAt !== undefined ? { resetAt: model.resetsAt } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
    };
  }

  // Limited, yet every window we can read still has room. That is not proven,
  // and the rule in this file is that not proven never becomes a cap.
  return { limited: false, detail: result.detail ?? 'limited, but no window is actually spent' };
}

/** A window is spent at 100%; anything below it still has room. */
const SPENT = 1;

/**
 * The account-wide window that is actually spent, carrying its OWN reset time.
 *
 * The reset matters as much as the verdict: falling back to a fixed backoff
 * kept an account out for five hours when its window reopened in sixteen
 * minutes, and it was the only one with Fable left.
 */
function spentAccountWindow(result: LimitProbeResult): { resetAt?: number } | null {
  if (typeof result.fiveHour === 'number' && result.fiveHour >= SPENT) {
    return result.fiveHourReset !== undefined ? { resetAt: result.fiveHourReset } : {};
  }
  if (typeof result.sevenDay === 'number' && result.sevenDay >= SPENT) {
    return result.sevenDayReset !== undefined ? { resetAt: result.sevenDayReset } : {};
  }
  return null;
}

/** The first model whose own window is spent, for when the probe named none. */
function spentModelWindow(result: LimitProbeResult) {
  return (
    (result.models ?? []).find((m) => typeof m.utilization === 'number' && m.utilization >= SPENT) ??
    null
  );
}
