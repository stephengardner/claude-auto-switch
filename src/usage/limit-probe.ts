import { readFileSync } from 'node:fs';

/**
 * Read an account's real subscription usage, and verify whether it is actually
 * rate-limited, from Anthropic's dedicated OAuth usage endpoint. This is a plain
 * GET that costs no tokens and returns the same numbers the Claude usage page
 * shows: the 5-hour session window, the weekly "all models" window, and a
 * per-model breakdown (e.g. Fable's weekly window), each with a utilization
 * percent and a reset time.
 *
 * Rendered cap text on screen is never trusted directly (--continue and the
 * resume picker replay old cap messages, and code can mention rate limits); this
 * endpoint is the ground truth used to confirm or refute a cap before switching.
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
  /** 0..1 utilization for the weekly "all models" window. */
  sevenDay?: number;
  /** Reset times (epoch ms). */
  fiveHourReset?: number;
  sevenDayReset?: number;
  /** Per-model weekly windows (Fable, Opus, ...). */
  models?: ModelWindow[];
  detail?: string;
}

/** Read the OAuth access token from a credentials file, or null. */
export function readOauthToken(credentialsFile: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(credentialsFile, 'utf8')) as {
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
interface UsageResponse {
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
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
): Promise<LimitProbeResult> {
  const token = readOauthToken(credentialsFile);
  if (!token) return { verdict: 'unknown', detail: 'no oauth token' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetchImpl(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA,
        'user-agent': 'claude-auto-switch',
      },
      signal: controller.signal,
    });
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

    const fiveHour = frac(data.five_hour?.utilization);
    const sevenDay = frac(data.seven_day?.utilization);
    const models: ModelWindow[] = (data.limits ?? [])
      .filter((l) => l.kind === 'weekly_scoped' && l.scope?.model?.display_name)
      .map((l) => ({
        name: l.scope!.model!.display_name!,
        utilization: frac(l.percent) ?? 0,
        ...(epochMs(l.resets_at) !== undefined ? { resetsAt: epochMs(l.resets_at) } : {}),
        ...(l.severity ? { severity: l.severity } : {}),
      }));

    const usage: LimitProbeResult = {
      verdict: 'allowed',
      ...(fiveHour !== undefined ? { fiveHour } : {}),
      ...(sevenDay !== undefined ? { sevenDay } : {}),
      ...(epochMs(data.five_hour?.resets_at) !== undefined
        ? { fiveHourReset: epochMs(data.five_hour?.resets_at) }
        : {}),
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
): Promise<LimitProbeResult> {
  return probeLimit(credentialsFile, '', fetchImpl);
}
