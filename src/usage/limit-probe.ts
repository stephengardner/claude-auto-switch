import { readCredential } from '../accounts/credential-storage.js';
import { sha256Fingerprint } from '../util/fingerprint.js';

/**
 * Read an account's real subscription usage, and verify whether it is actually
 * rate-limited, from Anthropic's dedicated OAuth usage endpoint. This is a plain
 * GET that costs no tokens and returns the same numbers the Claude usage page
 * shows: the 5-hour session window, the weekly "all models" window, and a
 * per-model breakdown (e.g. Fable's weekly window), each with a utilization
 * percent and a reset time.
 *
 * Rendered cap text on screen is never trusted directly (a resumed conversation and the
 * resume picker replay old cap messages, and code can mention rate limits); this
 * endpoint is the ground truth used to confirm or refute a cap before switching.
 * When it cannot answer, only Claude's own record of the refused turn stands
 * in for it (session/refused-turn).
 */

export type LimitVerdict = 'limited' | 'allowed' | 'unknown';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';

/** A per-model (or per-scope) weekly window from the usage response. */
export interface ModelWindow {
  /** Display name, e.g. "Fable". */
  name: string;
  /** 0..1 utilization. */
  utilization: number;
  /** Epoch ms reset time, when present. */
  resetsAt?: number;
  /** Raw severity string from the API (e.g. "normal", "warning"). */
  severity?: string;
}

export interface LimitProbeResult {
  verdict: LimitVerdict;
  /** When only one model is out, its name (for example "Fable"). */
  limitedModel?: string;
  /** Set when the endpoint asked us to back off (429), in ms. */
  retryAfterMs?: number;
  /** 0..1 utilization for the 5-hour session window. */
  fiveHour?: number;
  /**
   * True when the account has no 5-hour limit at all, only weekly ones: since
   * 2026-10-30 a verified Ultra account. Set only on positive evidence (see
   * hasNoFiveHourLimit), so an absent 5-hour number alone never claims it.
   */
  noFiveHourLimit?: boolean;
  /** 0..1 utilization for the weekly "all models" window. */
  sevenDay?: number;
  /** Reset times (epoch ms). */
  fiveHourReset?: number;
  sevenDayReset?: number;
  /** Per-model weekly windows (Fable, Opus, ...). */
  models?: ModelWindow[];
  /**
   * True when usage credits will carry this account PAST its plan limit.
   *
   * A spent plan window then says nothing about whether work will be served, so
   * it must not be read as the account being out of room.
   */
  creditsCarryPastLimit?: boolean;
  detail?: string;
  /**
   * Set when the endpoint turned the login away (401): the token was revoked,
   * or expired before its stored expiry says. `token` fingerprints the access
   * token it refused, so a renewal can be made for that token and no other.
   * Not a verdict on the account: only the token endpoint can say whether the
   * login behind it is finished.
   */
  rejected?: { message: string; token: string };
}

/** Read the OAuth access token from a credentials file, or null. */
export function readOauthToken(credentialsFile: string): string | null {
  try {
    const parsed = JSON.parse(readCredential(credentialsFile)) as {
      claudeAiOauth?: { accessToken?: string };
    };
    return parsed.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

interface UsageWindow {
  utilization?: number | null;
  resets_at?: string | null;
}
interface UsageLimit {
  kind?: string;
  percent?: number | null;
  severity?: string | null;
  resets_at?: string | null;
  is_active?: boolean | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
}
/** The "usage credits" block: paid usage beyond the plan's included limits. */
interface ExtraUsage {
  is_enabled?: boolean | null;
  /** True once the spend cap is reached, at which point credits stop covering. */
  spend_limit_reached?: boolean | null;
}
interface UsageResponse {
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
  extra_usage?: ExtraUsage | null;
  limits?: UsageLimit[] | null;
}

/** Utilization comes back as a 0..100 percent; normalize to a 0..1 fraction. */
function frac(v: number | null | undefined): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return v / 100;
}

function epochMs(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

/** The `error.message` of an API error body, or null when the body is anything else. */
async function serverMessage(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } };
    return typeof body.error?.message === 'string' ? body.error.message : null;
  } catch {
    return null;
  }
}

/** Claude's name for the 5-hour window in `limits`. */
const SESSION_KIND = 'session';

/**
 * The 5-hour window's reading: the `five_hour` block, or the `session` entry
 * of `limits` when that block carries no number. The two say the same thing
 * today; reading both keeps a reading when one of them is left out.
 */
function fiveHourReading(data: UsageResponse): { used?: number; resetsAt?: number } {
  const block = frac(data.five_hour?.utilization);
  if (block !== undefined) return { used: block, resetsAt: epochMs(data.five_hour?.resets_at) };
  const session = (data.limits ?? []).find((l) => l.kind === SESSION_KIND && frac(l.percent) !== undefined);
  if (session) return { used: frac(session.percent), resetsAt: epochMs(session.resets_at) };
  return {};
}

/**
 * Whether the answer shows an account with no 5-hour limit: a verified Ultra
 * account since 2026-10-30, which Claude's usage page shows with no "Current
 * session" bar. The endpoint then sends `five_hour: null` and no `session`
 * entry in `limits`; a block or an entry with no number reads the same.
 *
 * Positive evidence only. The `limits` list must be there, so an older or
 * partial answer that left the 5-hour window out is not taken for one that
 * has none, and the week must have been read, so an answer with nothing in it
 * claims nothing. Saying "no limit" wrongly would hide a real 5-hour window
 * behind a word; not saying it costs only a "?" where "no limit" belongs.
 */
function hasNoFiveHourLimit(data: UsageResponse, reading: { used?: number }, sevenDay: number | undefined): boolean {
  return reading.used === undefined && Array.isArray(data.limits) && sevenDay !== undefined;
}

/** A limit is "hit" at/over 100%, or when its severity says so. */
function isHit(percent: number | null | undefined, severity: string | null | undefined): boolean {
  if (typeof percent === 'number' && percent >= 100) return true;
  return typeof severity === 'string' && /exhaust|reject|block|over_?limit|limit_reached/i.test(severity);
}

/**
 * Fetch usage + decide a limit verdict from ONE GET. Fail-safe: no token, a
 * network error, or an unexpected status all yield verdict 'unknown' (never a
 * false 'limited'). `renderedText` narrows the verdict to a named model's window
 * when a per-model cap is on screen (e.g. "Fable 5 limit").
 */
export async function probeLimit(
  credentialsFile: string,
  renderedText = '',
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<LimitProbeResult> {
  const token = readOauthToken(credentialsFile);
  if (!token) return { verdict: 'unknown', detail: 'no oauth token' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA,
        'user-agent': 'claude-auto-switch',
      },
      signal: controller.signal,
    });
    if (res.status === 401) {
      return {
        verdict: 'unknown',
        detail: 'status 401',
        rejected: { message: (await serverMessage(res)) ?? 'status 401', token: sha256Fingerprint(token) },
      };
    }
    if (res.status !== 200) {
      // The usage endpoint has its own small budget: asking for several accounts
      // at once gets most of them turned away. Surface the back-off so callers
      // can pace themselves instead of hammering it.
      const retry = Number(res.headers.get('retry-after'));
      return {
        verdict: 'unknown',
        detail: `status ${res.status}`,
        ...(Number.isFinite(retry) && retry > 0 ? { retryAfterMs: retry * 1000 } : {}),
      };
    }
    const data = (await res.json()) as UsageResponse;

    const fiveHourRead = fiveHourReading(data);
    const fiveHour = fiveHourRead.used;
    const sevenDay = frac(data.seven_day?.utilization);
    const noFiveHourLimit = hasNoFiveHourLimit(data, fiveHourRead, sevenDay);
    const models: ModelWindow[] = (data.limits ?? [])
      .filter((l) => l.kind === 'weekly_scoped' && l.scope?.model?.display_name)
      .map((l) => ({
        name: l.scope!.model!.display_name!,
        utilization: frac(l.percent) ?? 0,
        ...(epochMs(l.resets_at) !== undefined ? { resetsAt: epochMs(l.resets_at) } : {}),
        ...(l.severity ? { severity: l.severity } : {}),
      }));

    // Credits only carry the account while they are switched ON and the spend
    // cap has not been reached. Either one missing and a spent plan window
    // really does mean no more work.
    const credits = data.extra_usage;
    const creditsCarry = credits?.is_enabled === true && credits.spend_limit_reached !== true;

    const usage: LimitProbeResult = {
      verdict: 'allowed',
      ...(creditsCarry ? { creditsCarryPastLimit: true } : {}),
      ...(fiveHour !== undefined ? { fiveHour } : {}),
      ...(noFiveHourLimit ? { noFiveHourLimit: true } : {}),
      ...(sevenDay !== undefined ? { sevenDay } : {}),
      ...(fiveHourRead.resetsAt !== undefined ? { fiveHourReset: fiveHourRead.resetsAt } : {}),
      ...(epochMs(data.seven_day?.resets_at) !== undefined
        ? { sevenDayReset: epochMs(data.seven_day?.resets_at) }
        : {}),
      ...(models.length > 0 ? { models } : {}),
    };

    // A per-model cap on screen: decide from THAT model's window when we can
    // match it, so a Fable cap is not masked by a healthy all-models number.
    const named = models.find((m) => renderedText.toLowerCase().includes(m.name.toLowerCase()));
    if (named && named.utilization >= 1) {
      // Scoped on purpose: this account still works on every other model.
      return {
        ...usage,
        verdict: 'limited',
        limitedModel: named.name,
        detail: `${named.name} weekly at limit`,
      };
    }

    const accountWideOut =
      (fiveHour !== undefined && fiveHour >= 1) || (sevenDay !== undefined && sevenDay >= 1);
    if (accountWideOut) return { ...usage, verdict: 'limited' };

    // A per-model window at its limit stops that model only, so name it.
    const spentModel = models.find((m) => m.utilization >= 1);
    if (spentModel) {
      return { ...usage, verdict: 'limited', limitedModel: spentModel.name, detail: `${spentModel.name} at limit` };
    }
    const otherLimit = (data.limits ?? []).some(
      (l) => l.is_active !== false && isHit(l.percent, l.severity),
    );
    return { ...usage, verdict: otherLimit ? 'limited' : 'allowed' };
  } catch (err) {
    return { verdict: 'unknown', detail: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** Read the account-wide usage picture (no cap decision needed). */
export function probeUsage(
  credentialsFile: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs?: number,
): Promise<LimitProbeResult> {
  return probeLimit(credentialsFile, '', fetchImpl, timeoutMs);
}
