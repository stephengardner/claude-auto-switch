import type { Refusal } from './transcript.js';
import type { PathCtx } from '../config/paths.js';
import { otherLiveWriter } from './other-writers.js';

/**
 * Whether a refused turn in Claude's own record proves, on its own, that the
 * login now under the session is out of a usage limit, and of which one.
 * Asked only when ccx's usage check cannot answer: the endpoint has a small
 * budget shared by every session on the machine, so it answers 429 exactly
 * when many sessions are busy, which is also when limits are met.
 *
 * Text on the screen never proves it: a resumed conversation replays old
 * limit messages, and a conversation can be about limits. The record is
 * different, since Claude writes the API's own answer there, with the limit
 * and when it resets. But an entry speaks only for the turn it refused, so it
 * proves something only when that is the turn in front of the session now,
 * on the login it is on now, and when no other Claude ccx knows of is working
 * on the same conversation, since every Claude on a conversation writes to
 * its one record (see other-writers).
 */

/**
 * How long after the login under a running Claude changed a refusal may
 * still be the old login's. Claude keeps a login it has read for up to 30 s
 * (see nudgeLoginReread), and a request sent on it at the end of that time is
 * answered, and its refusal written, a little later: 10 s more covers a slow
 * answer, since a usage limit is refused when the request arrives.
 */
const LOGIN_KEPT_MS = 30_000;
const OLD_LOGIN_MS = LOGIN_KEPT_MS + 10_000;

/**
 * Refusals are judged within seconds of being written, or at the latest
 * when Claude exits; older than this, it is no longer the turn in front of
 * the session.
 */
export const REFUSAL_MAX_AGE_MS = 2 * 60_000;

/** How far into the future a refusal's time may be, for clocks a little apart. */
const CLOCK_SKEW_MS = 5_000;

/**
 * The API's code for a turn refused because a usage limit is spent. Claude
 * 2.1.292 to 2.1.302 wrote it on every such refusal measured on one machine;
 * 2.1.284 and older write no code. It is written for a limit on one model
 * too, so which limit it was is read from the limit's own name.
 */
const LIMIT_REACHED = 'usage_limit_reached';

/**
 * Claude's names for its limits (`rate_limit_info.rateLimitType`), as the
 * 2.1.302 binary sorts them: the whole account's, or one model's, by the
 * usage check's name for that model. The binary calls
 * `seven_day_overage_included` the "Fable limit". Any other name, such as one
 * added later, is not taken as either.
 */
const ACCOUNT_LIMITS = new Set(['five_hour', 'seven_day']);
// A Map, so a name off the record such as "constructor" finds nothing inherited.
const MODEL_LIMITS = new Map([
  ['seven_day_opus', 'Opus'],
  ['seven_day_sonnet', 'Sonnet'],
  ['seven_day_overage_included', 'Fable'],
]);

/**
 * The limit Claude's name for it (`limitType`) stands for: the whole
 * account's (no model), or one model's, or null for a name ccx does not know.
 */
export function limitNamed(limitType: string | undefined): { model?: string } | null {
  const type = limitType ?? '';
  const model = MODEL_LIMITS.get(type);
  if (model !== undefined) return { model };
  return ACCOUNT_LIMITS.has(type) ? {} : null;
}

/** A refused turn from the record, with what tells whether it is the session's own turn now. */
export interface RecordedRefusal {
  refusal: Refusal;
  /** When this Claude was started, by the clock the record's times are in. */
  launchedAt: number;
  /** When a prompt was last typed at it, a carry-on prompt included; 0 when none has been seen. */
  promptAt: number;
  /** The conversation whose record it is, when known. */
  conversation: string | null;
  /** The pid of the Claude this session runs, the one writer the record should have. */
  claudePid: number | null;
  /**
   * Whether this process's own output shows it: a worker's, or a `claude -p`
   * run's, which is its own stream. Absent for a terminal session, whose
   * screen Claude draws by changed cells only. It may wait a moment: the
   * record and the output are written together, and either can be read first.
   */
  shown?: () => Promise<boolean>;
  /** Another live Claude ccx knows of on the same conversation, in words, or null (see other-writers). */
  otherWriter?: () => string | null;
}

/** What a refused turn proves on its own, and in words: what it was, or why it is not proof. */
export interface RefusalProof {
  proves: boolean;
  why: string;
  /** Set when the limit is one model's, by the usage check's name for it. */
  model?: string;
  /** When the limit resets, as the refusal itself says. */
  resetAt?: number;
}

/**
 * Judge `recorded` at `now` against the login under this Claude, last
 * replaced at `loginChangedAt` (0 when it never was).
 */
export async function refusalProof(
  recorded: RecordedRefusal,
  loginChangedAt: number,
  now: number = Date.now(),
): Promise<RefusalProof> {
  const { refusal, launchedAt, promptAt } = recorded;
  const not = (why: string): RefusalProof => ({ proves: false, why });
  if (refusal.apiError !== LIMIT_REACHED) {
    return not(`the refusal (${refusal.apiError ?? refusal.error}) does not say a usage limit is spent`);
  }
  const type = refusal.limitType ?? '';
  const named = limitNamed(type);
  if (named === null) return not(`the refusal does not say which limit it is (${type || 'no name'})`);
  const { model } = named;
  const at = refusal.at;
  if (at === null) return not('the refusal carries no time, so it may not be this turn');
  if (at > now + CLOCK_SKEW_MS) return not('the refusal is stamped in the future');
  if (at < launchedAt) return not('the refusal was recorded before this Claude started');
  if (at < now - REFUSAL_MAX_AGE_MS) return not('the refusal is more than 2 minutes old');
  if (refusal.resetsAt !== undefined && refusal.resetsAt <= now) return not('the limit it names has reset since');
  if (at < promptAt) return not('a prompt was typed after the refusal');
  // A login put in before Claude started is one it read fresh. One put in
  // while it ran may still be the one a request went out on, unless the turn
  // began after Claude can have kept the old one.
  if (loginChangedAt > launchedAt) {
    if (at < loginChangedAt) return not('the refusal was recorded before the login under Claude changed');
    const turnOnNewLogin = promptAt >= loginChangedAt + LOGIN_KEPT_MS;
    if (at < loginChangedAt + OLD_LOGIN_MS && !turnOnNewLogin) {
      return not('the refusal came within 40 s of the login changing under Claude, so it may be the old login');
    }
  }
  const other = recorded.otherWriter?.() ?? null;
  if (other !== null) return not(`${other} is on this conversation too, so the refusal may be its`);
  // Last, since it may wait.
  if (recorded.shown && !(await recorded.shown())) {
    return not('this run did not print the refusal, so another may have written it');
  }
  return {
    proves: true,
    why: `Claude recorded the turn as refused (${LIMIT_REACHED}, ${type})`,
    ...(model !== undefined ? { model } : {}),
    ...(refusal.resetsAt !== undefined ? { resetAt: refusal.resetsAt } : {}),
  };
}

/** Where another live Claude on a refusal's conversation is looked for (see other-writers). */
export interface WriterLookup {
  /** The session's own folder, whose announcement is its own; null for a launch with none. */
  sessionDir: string | null;
  /** The accounts' folders, where a Claude started in one keeps its per-process record. */
  configDirs: () => string[];
  ctx: PathCtx;
  /** Whether a pid is a live Claude; injected in tests, where the fake claude runs as `node`. */
  isClaude?: (pid: number) => boolean;
}

/**
 * The judgement a usage check asks for when it cannot answer (confirm-cap's
 * `refusal`): `recorded` by refusalProof's rules, with another live Claude on
 * its conversation looked for as `lookup` says. `loginChangedAt` is read when
 * the judgement is made, since the check comes first.
 */
export function judgeRefusal(
  recorded: RecordedRefusal,
  lookup: WriterLookup,
  loginChangedAt: () => number,
): () => Promise<RefusalProof> {
  const otherWriter = (): string | null =>
    recorded.conversation === null
      ? null
      : otherLiveWriter(
          recorded.conversation,
          { sessionDir: lookup.sessionDir, claudePid: recorded.claudePid, configDirs: lookup.configDirs() },
          lookup.ctx,
          lookup.isClaude ? { isClaude: lookup.isClaude } : {},
        );
  return () => refusalProof({ ...recorded, otherWriter }, loginChangedAt());
}
