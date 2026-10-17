import path from 'node:path';
import { capProbeCredential } from './cap-probe-credential.js';
import { normalizeModel } from './model-preference.js';
import { isUsableCredential, CREDENTIALS_FILE } from '../accounts/credential-vault.js';
import { probeLimit, type LimitProbeResult } from './limit-probe.js';
import type { RefusalProof } from '../session/refused-turn.js';

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
  /**
   * The probe said limited and ccx could not account for it in any window it
   * can read. Not a cap, and never treated as one here, but the one refusal
   * that can be WRONG about a limit that is really happening: everything else
   * this file refuses is a case where the API positively reported room.
   */
  unverified?: true;
  /** The usage check gave no answer: turned away, unreachable, or out of time. */
  unanswered?: true;
  /** Proved by Claude's own record of the refused turn, the usage check having given no answer. */
  byRefusal?: true;
  /** What that record proved, or why it did not, when it was asked. */
  refusalWhy?: string;
  /** How many times the usage check was asked, when it was more than once. */
  asks?: number;
  /** A back-off the usage endpoint asked for that was longer than a check waits, in ms. */
  backOffMs?: number;
}

export interface ConfirmCapDeps {
  /** Injected in tests; the real one is a plain GET that costs no tokens. */
  probe?: (credentialsFile: string, renderedText: string) => Promise<LimitProbeResult>;
  /** Used only before an account is chosen, when nothing can be capped yet. */
  sessionCredentials?: string;
  /**
   * The model the session is actually running.
   *
   * A spent window for a model you are NOT using is not a limit on you. The
   * session moves to Opus, the account's Fable stays at 100% forever, and any
   * limit-looking text (a resumed conversation replays the old cap message
   * every time) re-confirmed that spent Fable and ended the session. Measured:
   * ten rotations in six minutes, each session lasting under twenty seconds.
   *
   * Unknown keeps the old behaviour, since a session with nothing pinned is
   * running the default model, which is the one a spent window most likely
   * refers to.
   */
  modelInUse?: string | null;
  /**
   * Judges Claude's own record of the refused turn that started this check
   * (session/refused-turn). Asked only when the usage check gives no answer,
   * after it has been asked, so it reads what Claude has shown by then; and it
   * counts only when it proves the limit on its own.
   */
  refusal?: () => Promise<RefusalProof>;
  /** Injected in tests: how a back-off the usage endpoint asks for is waited out. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Ask the account's own credential whether it is really out, and how widely.
 *
 * Refuses on anything short of a confirmed limit. An unreachable endpoint, a
 * missing token, a 429: all of those mean "not proven", and not proven must
 * never become a cap, unless Claude's own record of the refused turn proves it
 * (`deps.refusal`). A session that keeps hitting a real limit will trigger
 * this again; a healthy account wrongly capped stays broken for hours.
 */
export async function confirmCap(
  accountDir: string | null | undefined,
  renderedText: string,
  deps: ConfirmCapDeps = {},
): Promise<CapDecision> {
  const probe = deps.probe ?? probeLimit;
  const credentials = capProbeCredential(accountDir, deps.sessionCredentials ?? '');
  // An endpoint that cannot be asked is one that gives no answer.
  if (!credentials) return unanswered('no credential to ask', deps.refusal);
  return decide(await askUsage(probe, credentials, renderedText, deps.sleep ?? pause), deps);
}

/**
 * How long one check waits, from its start, for a back-off the usage endpoint
 * asks for before asking it again. With the second ask's own limit and the
 * renewal a confirmed limit may add, a check stays within the 10 s a session
 * gives it (CHECK_BUDGET_MS in commands/session).
 */
const BACK_OFF_WAIT_MS = 4_000;
/** How long the second ask has to answer. */
const SECOND_ASK_MS = 3_000;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Asked {
  result: LimitProbeResult;
  asks: number;
  /** The back-off the endpoint asked for, when it was too long to wait out. */
  backOffMs?: number;
}

/**
 * Ask the usage endpoint, and ask again after the back-off it asks for when
 * that fits in BACK_OFF_WAIT_MS. Asking sooner than it says only spends its
 * budget, which every session on the machine shares, again.
 */
async function askUsage(
  probe: (credentialsFile: string, renderedText: string) => Promise<LimitProbeResult>,
  credentials: string,
  renderedText: string,
  sleep: (ms: number) => Promise<void>,
): Promise<Asked> {
  const startedAt = Date.now();
  const first = await probeSafely(probe, credentials, renderedText);
  const wait = first.verdict === 'unknown' ? first.retryAfterMs : undefined;
  if (wait === undefined) return { result: first, asks: 1 };
  if (Date.now() - startedAt + wait > BACK_OFF_WAIT_MS) {
    return { result: first, asks: 1, backOffMs: wait };
  }
  await sleep(wait);
  const second = await answerWithin(probeSafely(probe, credentials, renderedText), SECOND_ASK_MS);
  return { result: second, asks: 2 };
}

/** What `asked` comes to, or no answer once `ms` have passed first. */
function answerWithin(asked: Promise<LimitProbeResult>, ms: number): Promise<LimitProbeResult> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<LimitProbeResult>((resolve) => {
    const noAnswer: LimitProbeResult = { verdict: 'unknown', detail: `no answer in ${ms / 1000} s` };
    timer = setTimeout(() => resolve(noAnswer), ms);
    timer.unref?.();
  });
  return Promise.race([asked, late]).finally(() => clearTimeout(timer));
}

/** What the usage check said, in words, and how it was asked when that was more than once. */
export function usageAnswer(decision: CapDecision): string {
  const said = decision.detail ?? 'no answer';
  if (decision.backOffMs !== undefined) {
    return `${said}; it asked to wait ${Math.round(decision.backOffMs / 100) / 10} s, longer than a check waits`;
  }
  return decision.asks !== undefined ? `${said}, asked ${decision.asks} times` : said;
}

/** How the log says that Claude's record of a refused turn confirmed a limit the usage check could not. */
export function refusalConfirmed(decision: CapDecision): string {
  return (
    `the usage check could not answer (${usageAnswer(decision)}), ` +
    `but ${decision.refusalWhy ?? 'Claude recorded the turn as refused'}, which confirms the limit`
  );
}

/**
 * When a limit a refused turn confirmed (`byRefusal`) ends: at the reset the
 * refusal names, which is that turn's own. Without one, a limit on the whole
 * account keeps the end already on the ledger for it, `ledgerEnd` (another
 * session's answered check, moments ago when the endpoint is this busy), and
 * otherwise undefined, which leaves the configured backoff.
 */
export function refusalLimitEnd(decision: CapDecision, ledgerEnd: () => number | undefined): number | undefined {
  return decision.resetAt ?? (decision.model ? undefined : ledgerEnd());
}

/** The decision from what the usage check said, and how it was asked. */
async function decide(asked: Asked, deps: ConfirmCapDeps): Promise<CapDecision> {
  const { result } = asked;
  return {
    ...(result.verdict === 'unknown'
      ? await unanswered(result.detail ?? result.verdict, deps.refusal)
      : decideFromProbe(result, deps.modelInUse ?? null)),
    ...(asked.asks > 1 ? { asks: asked.asks } : {}),
    ...(asked.backOffMs !== undefined ? { backOffMs: asked.backOffMs } : {}),
  };
}

/**
 * A probe that rejects is the least proven case of all, so it must come back
 * as "not confirmed" rather than as an exception. The real probe never
 * rejects, but this function cannot know which probe it was given, and a
 * network failure escaping here has taken headless rotation down whole.
 */
async function probeSafely(
  probe: (credentialsFile: string, renderedText: string) => Promise<LimitProbeResult>,
  credentials: string,
  renderedText: string,
): Promise<LimitProbeResult> {
  try {
    return await probe(credentials, renderedText);
  } catch {
    return { verdict: 'unknown', detail: 'could not confirm usage limit' };
  }
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
  if (!credentials) return { ...(await unanswered('no credential to ask', deps.refusal)), askedOf };
  return {
    ...(await decide(await askUsage(probe, credentials, renderedText, deps.sleep ?? pause), deps)),
    askedOf,
  };
}

/**
 * No answer from the usage check: a limit only when Claude's own record of
 * the refused turn proves it, as wide as the record says (the account, or one
 * model) and until the reset it names.
 */
async function unanswered(
  detail: string,
  judge: (() => Promise<RefusalProof>) | undefined,
): Promise<CapDecision> {
  // A judgement that fails proves nothing, the same as a probe that does.
  const proof = judge ? await judge().catch(() => undefined) : undefined;
  const proved = proof?.proves === true ? proof : undefined;
  return {
    limited: proved !== undefined,
    unanswered: true,
    ...(proved ? { byRefusal: true as const } : {}),
    ...(proved?.model !== undefined ? { model: proved.model } : {}),
    ...(proved?.resetAt !== undefined ? { resetAt: proved.resetAt } : {}),
    ...(proof ? { refusalWhy: proof.why } : {}),
    detail,
  };
}

function decideFromProbe(result: LimitProbeResult, modelInUse: string | null): CapDecision {
  if (result.verdict !== 'limited') {
    return { limited: false, detail: result.detail ?? result.verdict };
  }

  // Checked FIRST, before any named model: an account-wide window that is
  // genuinely spent makes every model unusable, and the probe can name a model
  // (from the rendered text) while the five-hour window is spent too. Scoping
  // to the model then would leave the account in rotation with nothing to run
  // on. An account-wide cap still has to be EARNED: this branch used to be
  // reached by assumption (any "limited" verdict without a model became
  // account-wide), which locked out an account with 2% of its five-hour window
  // used because its Fable was gone.
  // Usage credits carry the account past its plan limit, so a spent plan window
  // is not the account being out of room. Missing this is how an operator who
  // had bought credits was told every account had hit its limit, and could not
  // start Claude at all.
  const accountWindow = result.creditsCarryPastLimit ? null : spentAccountWindow(result);
  if (accountWindow) {
    return { limited: true, ...accountWindow, ...(result.detail ? { detail: result.detail } : {}) };
  }

  // Nothing account-wide is spent, so a spent model is the whole story: the
  // account keeps working on everything else. The model the probe NAMED wins
  // over a scan, since it was matched against the text on screen.
  const named = result.limitedModel
    ? ((result.models ?? []).find((m) => m.name === result.limitedModel) ?? {
        name: result.limitedModel,
        utilization: 1,
      })
    : null;
  const model = named ?? spentModelWindow(result);
  if (model) {
    // A window spent on a model this session is NOT running says nothing about
    // this session. Once ccx moves to Opus, the account's Fable stays at 100%
    // for the rest of the week, so every replayed cap message would re-confirm
    // it and end the session within seconds, over and over.
    if (modelInUse && normalizeModel(model.name) !== normalizeModel(modelInUse)) {
      return {
        limited: false,
        unverified: true,
        detail: `${model.name} is spent, but this session is running ${modelInUse}`,
      };
    }
    return {
      limited: true,
      model: model.name,
      ...(model.resetsAt !== undefined ? { resetAt: model.resetsAt } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
    };
  }

  // Limited, yet every window we can read still has room. That is not proven,
  // and the rule in this file is that not proven never becomes a cap.
  return {
    limited: false,
    unverified: true,
    detail: result.detail ?? 'limited, but no window is actually spent',
  };
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
