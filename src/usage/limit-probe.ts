import { readFileSync } from 'node:fs';

/**
 * Verify whether an account is ACTUALLY rate-limited by asking the API, instead
 * of trusting rendered text. A cap message on screen can be historical (replayed
 * by --continue / the resume picker) or even the user's own code discussing rate
 * limits; acting on it without verification is what caused the false-cap
 * rotation cascade. The API response is ground truth: a minimal request returns
 * the subscription's unified rate-limit state in its headers (the same signal
 * Claude Code's own status bar uses).
 */

export type LimitVerdict = 'limited' | 'allowed' | 'unknown';

/** Model ids for probing, mapped from names appearing in rendered cap messages. */
const MODEL_HINTS: Array<{ re: RegExp; model: string }> = [
  { re: /fable/i, model: 'claude-fable-5' },
  { re: /opus/i, model: 'claude-opus-4-8' },
  { re: /sonnet/i, model: 'claude-sonnet-4-6' },
  { re: /haiku/i, model: 'claude-haiku-4-5-20251001' },
];
const BASE_MODEL = 'claude-haiku-4-5-20251001';

/** Pick the probe model from the rendered message (a per-model cap needs a per-model probe). */
export function probeModelFor(renderedText: string): string {
  for (const h of MODEL_HINTS) {
    if (h.re.test(renderedText)) return h.model;
  }
  return BASE_MODEL;
}

export interface LimitProbeResult {
  verdict: LimitVerdict;
  /** 0..1 utilization when the response carried it. */
  fiveHour?: number;
  sevenDay?: number;
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

/**
 * Ask the API whether this credential is currently limited, optionally for the
 * model named in a rendered message. Fail-safe: anything ambiguous (no token,
 * network error, unexpected status) returns 'unknown' -- callers must treat that
 * as NOT confirmation of a cap.
 */
export async function probeLimit(
  credentialsFile: string,
  renderedText = '',
  fetchImpl: typeof fetch = fetch,
): Promise<LimitProbeResult> {
  const token = readOauthToken(credentialsFile);
  if (!token) return { verdict: 'unknown', detail: 'no oauth token' };

  const attempt = async (model: string): Promise<LimitProbeResult & { notFound?: boolean }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: '.' }] }),
        signal: controller.signal,
      });
      const fiveHour = num(res.headers.get('anthropic-ratelimit-unified-5h-utilization'));
      const sevenDay = num(res.headers.get('anthropic-ratelimit-unified-7d-utilization'));
      const usage = {
        ...(fiveHour !== undefined ? { fiveHour } : {}),
        ...(sevenDay !== undefined ? { sevenDay } : {}),
      };
      if (res.status === 429) return { verdict: 'limited', ...usage, detail: `429 on ${model}` };
      if (res.status === 404) return { verdict: 'unknown', notFound: true, detail: `unknown model ${model}` };
      if (res.status === 200) {
        const status = res.headers.get('anthropic-ratelimit-unified-status');
        if (status && status !== 'allowed') {
          return { verdict: 'limited', ...usage, detail: `unified-status ${status}` };
        }
        return { verdict: 'allowed', ...usage };
      }
      return { verdict: 'unknown', ...usage, detail: `status ${res.status}` };
    } catch (err) {
      return { verdict: 'unknown', detail: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  };

  const model = probeModelFor(renderedText);
  const first = await attempt(model);
  // A stale model-name mapping must not blind us: fall back to the base model.
  if (first.notFound && model !== BASE_MODEL) return attempt(BASE_MODEL);
  return first;
}

function num(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
