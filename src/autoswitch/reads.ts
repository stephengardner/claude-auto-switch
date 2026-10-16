import { bindingUtilization, type UsageLike } from '../usage/headroom.js';
import type { LimitProbeResult } from '../usage/limit-probe.js';
import type { Reading } from './decide.js';
import { wideUtilization } from './target.js';

/**
 * What a usage read came to, kept apart from the numbers it carried.
 *
 * ccx's usage cache deliberately keeps the last numbers when a read fails and
 * stamps them with the time of the attempt, so that a broken network is tried
 * again once per cache lifetime rather than on every tick. That is right for a
 * cache and wrong for a watcher: a number that failed to refresh looks newly
 * checked, and a move made on it lands on an account that filled up in the
 * meantime. So the watcher asks the endpoint itself and keeps the outcome of
 * each read: answered, or how it failed.
 */

/** An HTTP status, or what went wrong before there was one. */
export type ReadStatus = number | 'timeout' | 'network' | 'no-token' | 'unknown';

export type UsageRead =
  | {
      ok: true;
      usage: UsageLike;
      result: LimitProbeResult;
      /** Usage credits carry the account past its plan windows: a full one does not stop it. */
      creditsCarry?: boolean;
    }
  | { ok: false; status: ReadStatus; retryAfterMs?: number };

/** Which read this was, for the counts `ccx autoswitch stats` shows. */
export type ReadKind = 'in-use' | 'target';

/**
 * How a failed probe failed. The probe reports a failure only as text
 * ("status 429", an abort, a fetch error), so this reads it back.
 */
export function statusOf(detail: string | undefined): ReadStatus {
  const text = detail ?? '';
  const status = /status (\d+)/.exec(text);
  if (status) return Number(status[1]);
  if (/no oauth token/i.test(text)) return 'no-token';
  if (/abort/i.test(text)) return 'timeout';
  return text === '' ? 'unknown' : 'network';
}

/**
 * Turn a probe result into an outcome. A read the endpoint answered counts
 * even when it carries no window at all: a seat billed by use has none, and
 * is never near a limit. Only a verdict of unknown is a failed read.
 */
export function readOutcome(result: LimitProbeResult): UsageRead {
  const answered =
    result.fiveHour !== undefined ||
    result.sevenDay !== undefined ||
    result.verdict === 'allowed' ||
    result.verdict === 'limited';
  if (!answered) {
    return {
      ok: false,
      status: statusOf(result.detail),
      ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
    };
  }
  return {
    ok: true,
    result,
    ...(result.creditsCarryPastLimit ? { creditsCarry: true } : {}),
    usage: {
      fiveHour: result.fiveHour ?? null,
      sevenDay: result.sevenDay ?? null,
      fiveHourReset: result.fiveHourReset ?? null,
      sevenDayReset: result.sevenDayReset ?? null,
      models: (result.models ?? []).map((m) => ({ name: m.name, utilization: m.utilization, resetsAt: m.resetsAt ?? null })),
    },
  };
}

/** The login itself was turned away, rather than the request or the network. */
export function isRefusal(status: ReadStatus): boolean {
  return status === 401 || status === 403;
}

/** A failure that says something about the account, not about the network between here and there. */
export function failureCounts(status: ReadStatus): boolean {
  return isRefusal(status) || status === 429 || (typeof status === 'number' && status >= 500);
}

/**
 * An answered read as the decision reads it. No window at all is no usage,
 * not unknown usage. With `model`, only that model's own week counts beside
 * the account-wide windows; without, every model's does.
 */
export function toReading(usage: UsageLike, at: number, model?: string, creditsCarry = false): Reading {
  return {
    used: bindingUtilization(usage, model, at) ?? 0,
    wide: wideUtilization(usage, at) ?? 0,
    ...(creditsCarry ? { carried: true } : {}),
    at,
  };
}

/** Which window is the tight one, in words, for the log. */
export function bindingLabel(usage: UsageLike, now: number, model?: string): string {
  const used = bindingUtilization(usage, model, now);
  if (used === null) return 'no usage window';
  const pct = `${Math.round(used * 100)}%`;
  const open = (resetsAt: number | null | undefined): boolean => typeof resetsAt !== 'number' || resetsAt > now;
  if (usage.fiveHour === used && open(usage.fiveHourReset)) return `5-hour window ${pct}`;
  if (usage.sevenDay === used && open(usage.sevenDayReset)) return `week ${pct}`;
  const named = (usage.models ?? []).find(
    (m) => m.utilization === used && open(m.resetsAt) && (!model || m.name.toLowerCase() === model.toLowerCase()),
  );
  return named ? `${named.name} week ${pct}` : pct;
}

/** How many hours of read counts are kept. */
const KEPT_HOURS = 48;

const hourOf = (at: number): string => new Date(at).toISOString().slice(0, 13);

/**
 * Count one read under its hour, kind and status, and drop hours past the
 * last two days. The usage endpoint rate limits a login that is asked too
 * often, and these counts are how that shows up: as 429s per hour, with no
 * account named.
 */
export function countRead(
  counts: Record<string, Record<string, number>>,
  kind: ReadKind,
  status: ReadStatus | 200,
  at: number,
): Record<string, Record<string, number>> {
  const hour = hourOf(at);
  const key = `${kind} ${String(status)}`;
  const next = { ...counts, [hour]: { ...(counts[hour] ?? {}), [key]: (counts[hour]?.[key] ?? 0) + 1 } };
  const oldest = hourOf(at - KEPT_HOURS * 3_600_000);
  for (const bucket of Object.keys(next)) if (bucket < oldest) delete next[bucket];
  return next;
}

/**
 * The counts of the last `hours` hours, added up per kind and status. Counted
 * by clock hour, so the hour the span starts in is included whole.
 */
export function readTotals(
  counts: Record<string, Record<string, number>>,
  hours: number,
  now: number,
): Record<string, number> {
  const from = hourOf(now - hours * 3_600_000);
  const totals: Record<string, number> = {};
  for (const [bucket, perKey] of Object.entries(counts)) {
    if (bucket < from) continue;
    for (const [key, n] of Object.entries(perKey)) totals[key] = (totals[key] ?? 0) + n;
  }
  return totals;
}
