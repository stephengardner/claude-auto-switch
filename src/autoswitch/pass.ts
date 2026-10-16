import { bindingUtilization, type UsageLike } from '../usage/headroom.js';
import type { LimitProbeResult } from '../usage/limit-probe.js';
import {
  decide,
  fits,
  FRESH_MS,
  fullSkip,
  handPickHolds,
  isEarly,
  MINUTE,
  noneHolds,
  readEvery,
  standingPick,
  stayKind,
  type Decision,
  type HandPick,
  type MoveKind,
} from './decide.js';
import { pickTarget, wideUtilization, type TargetCandidate, type TargetPick } from './target.js';
import {
  bindingLabel,
  countRead,
  failureCounts,
  isRefusal,
  toReading,
  type ReadKind,
  type ReadStatus,
  type UsageRead,
} from './reads.js';
import type { Controls, WatchState } from './state.js';

/**
 * One pass of the auto-switch watcher.
 *
 * Read the account in use, decide, and when a move is due pick where to go,
 * read that account fresh, and switch under the lock. Everything it touches
 * is handed in, so a pass can be driven end to end with made-up accounts and
 * a made-up clock: no login, no network, no model call.
 *
 * It makes no model call in production either. Usage comes from the plain GET
 * ccx already uses for its own numbers, which costs no tokens.
 */

/** With the account in use spent, refused or unreadable, a target only has to be under this. */
export const SPENT_LIMIT = 0.95;
/** And only this much roomier: a little room somewhere beats every session stopped. */
export const SPENT_HYSTERESIS = 0.05;
/** A read is due this much early, so a loop that drifts a little still reads once a minute. */
const READ_SLACK_MS = 2_000;
/** How many targets one pass reads fresh before it gives up until the next. */
const MAX_TARGET_READS = 8;
/** How long a target a fresh read found full stays out. */
const FULL_MS = 5 * MINUTE;
/** How long a target stays out after a move there failed or its login was refused. */
const FAILED_MS = 120 * MINUTE;
/** A machine that could not be asked to follow is asked again this often, for this long. */
const FOLLOW_RETRY_MS = MINUTE;
const FOLLOW_FOR_MS = 10 * MINUTE;

/** An account as the watcher sees it. */
export interface WatchAccount {
  name: string;
  dir: string;
  /** Who the profile is registered for; two profiles with one address are one login. */
  email?: string;
  priority: number;
  enabled: boolean;
  loggedIn: boolean;
  /** ccx's ledger has a refused turn on record for it, account-wide, and the limit has not lifted. */
  capped: boolean;
}

export type SwitchOutcome =
  /** Switched; `sessions` running sessions were asked to follow in place. */
  | { code: 'done'; sessions: number }
  /** Another switch held the lock. */
  | { code: 'busy' }
  /** The account in use was no longer the one judged: someone switched first. */
  | { code: 'changed'; active: string | null }
  | { code: 'failed'; why: string };

/** How one machine that follows this one took a switch. */
export interface FollowOutcome {
  host: string;
  ok: boolean;
  detail: string;
  /** It could not be asked, or was busy: worth asking again. */
  retry?: boolean;
}

/** Something worth telling whoever is listening: once per switch, once per incident, never per pass. */
export type WatchEvent =
  | {
      type: 'switched';
      kind: MoveKind;
      from: string;
      to: string;
      by: string;
      /** The account left was one a person had picked, and it ran out. */
      pickRanOut: boolean;
      followers: FollowOutcome[];
    }
  | { type: 'no-room'; account: string; until: number | null };

export interface PassDeps {
  now: () => number;
  accounts: () => WatchAccount[];
  /** The active account: the one new sessions start on, and the one this watcher keeps ahead of its limits. */
  active: () => string | null;
  /** When the active account was last set, when that can be known. */
  activeSince: () => number | null;
  handPick: () => HandPick | null;
  clearHandPick: () => void;
  /** Since when the ledger has this account down as refused, or null. */
  cappedSince: (name: string) => number | null;
  /** One fresh read of an account's usage, with the login that answers for it. */
  read: (account: WatchAccount, kind: ReadKind) => Promise<UsageRead>;
  /** Whether that login's access token has yet to expire. An expired one is refused for that alone. */
  tokenLive: (account: WatchAccount) => boolean;
  /** File an answered reading where the rest of ccx reads usage. */
  record: (name: string, result: LimitProbeResult, at: number) => void;
  /** What ccx knows of every account's usage, refreshed under its own rules. Asked only when a move is due. */
  usage: () => Promise<Map<string, UsageLike>>;
  /** ccx's pick order, for the accounts that fit. */
  order: () => (a: TargetCandidate, b: TargetCandidate) => number;
  /** Make the switch, under the lock, only if `from` is still the account in use. */
  switchTo: (from: string, to: string, reason: string) => SwitchOutcome;
  controls: () => Controls;
  /** `model`: decide by that model's own week alone, beside the account-wide windows. */
  settings: () => { threshold: number; hysteresis: number; model?: string };
  loadState: () => WatchState;
  saveState: (state: WatchState) => void;
  log: (line: string) => void;
  announce: (event: WatchEvent) => Promise<void>;
  /**
   * Ask the machines that follow this one to make the same move, with why it
   * was made. `only`: just these, when some are being asked again.
   */
  follow: (from: string, to: string, kind: MoveKind, only?: readonly string[]) => Promise<FollowOutcome[]>;
  random?: () => number;
}

export interface PassOptions {
  /** Who ran this pass: the service, a person, another machine's watchdog. */
  by: string;
  /** Asked for by a person: read now rather than when the next read is due. */
  manual?: boolean;
  /** Move even though nothing calls for it. A pause still holds. */
  force?: boolean;
  /** Say what would happen; switch, write and announce nothing. */
  dryRun?: boolean;
}

export type PassOutcome =
  | 'switched'
  | 'would-switch'
  | 'stayed'
  | 'held'
  | 'no-room'
  | 'busy'
  | 'failed'
  | 'idle';

export interface PassReport {
  at: number;
  by: string;
  account: string | null;
  outcome: PassOutcome;
  detail: string;
  /** What the read of the account in use came to, when this pass made one. */
  read?: string;
  decision?: Decision;
  target?: TargetPick;
}

const pct = (fraction: number): string => `${Math.round(fraction * 100)}%`;

/** "in 25 min", "in 3h 10m", "in 2d 4h". */
export function inWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

async function quietly<T>(work: () => Promise<T>, otherwise: T): Promise<T> {
  try {
    return await work();
  } catch {
    return otherwise;
  }
}

export async function runPass(deps: PassDeps, options: PassOptions): Promise<PassReport> {
  const now = deps.now();
  const state = deps.loadState();
  const dry = options.dryRun === true;
  const accounts = deps.accounts();
  const active = deps.active();
  const current = active === null ? undefined : accounts.find((a) => a.name === active);

  const extras: Pick<PassReport, 'read' | 'decision' | 'target'> = {};
  const finish = (outcome: PassOutcome, detail: string): PassReport => {
    state.lastPassAt = now;
    state.lastPassBy = options.by;
    if (!dry) deps.saveState(state);
    return { at: now, by: options.by, account: current?.name ?? null, outcome, detail, ...extras };
  };
  /** A dry run writes nothing, its lines in the history included. */
  const log = (line: string): void => {
    if (!dry) deps.log(line);
  };
  /** One line when the watcher's situation changes, not one per pass while it lasts. */
  const once = (cat: string, line: string): void => {
    if (state.lastCat !== cat) log(line);
    state.lastCat = cat;
  };

  if (!current) {
    const why = active === null ? 'no account is active' : `the active account "${active}" is not registered`;
    once('no-account', `${why}; nothing to watch`);
    state.lastWhy = why;
    return finish('idle', why);
  }

  if (state.account?.name !== current.name) {
    // Whoever changed it (a person, a session moving itself on, this watcher's
    // own switch is already recorded): what was known was about another account.
    if (state.account) log(`the account in use is now ${current.name} (was ${state.account.name})`);
    state.account = { name: current.name, since: Math.min(now, deps.activeSince() ?? now) };
    state.reads = [];
    state.none = null;
    state.refusals = null;
    state.lastFailure = null;
    // Read the new account on this pass, so what the dashboard shows of it is at most a minute old.
    state.lastReadAt = 0;
    state.holdReadsUntil = 0;
    state.lastWhy = null;
    state.lastCat = null;
  }
  const since = state.account.since;
  const settings = deps.settings();

  // A machine that was asleep or mid-switch when the last switch was made is
  // asked again for a while. Without this it stays on the account just left,
  // and its sessions find out the hard way.
  if (state.follow && !dry) {
    const pending = state.follow;
    if (pending.to !== current.name || now >= pending.until) {
      state.follow = null; // overtaken by a newer switch, or long enough
    } else if (now - pending.lastAt >= FOLLOW_RETRY_MS) {
      pending.lastAt = now;
      const asked = await quietly<FollowOutcome[] | null>(
        () => deps.follow(pending.from, pending.to, pending.kind as MoveKind, pending.hosts),
        null,
      );
      if (asked !== null) {
        for (const outcome of asked) if (outcome.ok) log(`${outcome.host} followed, late: ${outcome.detail}`);
        const still = asked.filter((o) => !o.ok && o.retry).map((o) => o.host);
        state.follow = still.length > 0 ? { ...pending, hosts: still } : null;
      }
    }
  }

  // 1. Read the account in use, on the watcher's own clock.
  const reads = state.reads.filter((r) => now - r.at < 30 * MINUTE);
  const lastUsed = reads.at(-1)?.used ?? null;
  const cappedSince = deps.cappedSince(current.name);
  // The second look is wanted soon after the first, and only then: once two
  // readings agree the account is spent, or two reads were refused, there is
  // nothing left to confirm, and an account that stays spent for hours must
  // not be asked twice a minute for it.
  const lastRead = reads.at(-1);
  const spentOnce = lastRead !== undefined && lastRead.used >= 1 && !lastRead.carried && !((reads.at(-2)?.used ?? 0) >= 1);
  const refusedOnce = state.refusals?.count === 1;
  const every = options.manual ? 0 : readEvery(spentOnce || refusedOnce);
  if (now - state.lastReadAt >= every - READ_SLACK_MS && now >= state.holdReadsUntil) {
    state.lastReadAt = now;
    const read = await deps.read(current, 'in-use');
    state.counts = countRead(state.counts, 'in-use', read.ok ? 200 : read.status, now);
    if (read.ok) {
      reads.push(toReading(read.usage, now, settings.model, read.creditsCarry));
      state.lastOkAt = now;
      state.lastFailure = null;
      state.refusals = null;
      extras.read = bindingLabel(read.usage, now, settings.model);
      if (!dry) deps.record(current.name, read.result, now);
    } else {
      state.lastFailure = { at: now, status: read.status };
      if (read.status === 429) {
        // Asked to slow down. Near the limit a minute is as long as it can
        // afford to look away; with room to spare, five.
        const longest = lastUsed !== null && lastUsed >= 0.7 ? MINUTE : 5 * MINUTE;
        state.holdReadsUntil = now + Math.min(read.retryAfterMs ?? 2 * MINUTE, longest);
      }
      // A refusal only counts against a token that has not expired: an expired
      // one is refused for that alone, and the next session to use it renews it.
      if (isRefusal(read.status) && deps.tokenLive(current)) {
        state.refusals = { count: (state.refusals?.count ?? 0) + 1, first: state.refusals?.first ?? now, last: now };
      }
      extras.read = `usage read failed (${String(read.status)})`;
    }
  }
  state.reads = reads.slice(-6);

  // 2. Decide.
  const newest = state.reads.at(-1) ?? null;
  const fresh = newest !== null && now - newest.at <= FRESH_MS ? newest : null;
  const prev = fresh !== null && state.reads.length > 1 ? (state.reads[state.reads.length - 2] ?? null) : null;
  const readsFailing =
    state.lastFailure !== null &&
    failureCounts(state.lastFailure.status as ReadStatus) &&
    now - state.lastOkAt > 3 * MINUTE;
  let decision = decide({
    now,
    since,
    fresh,
    prev,
    lastKnown: newest,
    cappedSince,
    readsFailing,
    refusals: state.refusals,
    lastRiskyAt: state.lastRiskyAt,
    threshold: settings.threshold,
  });
  if (options.force && !decision.act) decision = { act: true, kind: 'forced', why: `asked by ${options.by}` };
  extras.decision = decision;

  if (!decision.act) {
    const steady = (cat: string | null): boolean => cat === null || cat === 'fine' || cat === 'quiet';
    // Fine and quiet trade places all day; neither is news after the other.
    if (state.lastCat !== decision.cat && !(steady(decision.cat) && steady(state.lastCat))) {
      log(`${current.name}: ${decision.why}`);
    }
    state.lastCat = decision.cat;
    state.lastWhy =
      options.manual && fresh
        ? `the account in use has room (${pct(fresh.used)} used); not switching (--force switches anyway)`
        : decision.why;
    if (decision.cat === 'fine') state.none = null;
    return finish('stayed', state.lastWhy);
  }

  // 3. What holds a move back: a pause holds every move; a person's own pick
  // and the early-moves switch hold the ones off an account that still runs.
  const controls = deps.controls();
  if (controls.paused !== null) {
    once('paused', `switching is paused (${controls.paused}); would have moved: ${decision.why}`);
    return finish('held', `switching is paused (${controls.paused})`);
  }
  const pick = standingPick(deps.handPick(), current.name, since);
  if (handPickHolds(pick, current.name, decision.kind)) {
    once('hand-pick', `${current.name} was picked by hand; no early move (${decision.why}). It still moves once it cannot run`);
    return finish('held', `${current.name} was picked by hand, which holds against an early move`);
  }
  if (isEarly(decision.kind) && controls.earlyOff) {
    once('early-off', `early moves are off; staying (${decision.why}). An account that cannot run still moves`);
    return finish('held', 'early moves are off');
  }
  const blocked = decision.kind === 'spent' || decision.kind === 'dead' || decision.kind === 'blind';
  const forced = decision.kind === 'forced';
  // A move a person forced, or asked to see, is looked for now whatever was found three minutes ago.
  if (noneHolds(state.none, now, blocked) && !options.manual && !options.force && !dry) {
    return finish('no-room', 'no account had room under three minutes ago');
  }

  // 4. Pick where to go from what ccx knows now, read that account fresh, and
  // switch under the lock.
  let usage: Map<string, UsageLike>;
  try {
    usage = await deps.usage();
  } catch (err) {
    once('usage-failed', `could not read the other accounts (${(err as Error).message}); looking again on the next pass`);
    return finish('failed', 'could not read the other accounts');
  }
  const candidates: TargetCandidate[] = accounts.map((a) => ({
    name: a.name,
    priority: a.priority,
    enabled: a.enabled,
    loggedIn: a.loggedIn,
    capped: a.capped,
    usage: usage.get(a.name) ?? null,
  }));
  const address = current.email?.toLowerCase();
  const sameLogin = address
    ? accounts.filter((a) => a.email?.toLowerCase() === address).map((a) => a.name)
    : [current.name];
  // Nothing read means nothing known: judged as full, so a target has to be
  // roomy in its own right rather than merely roomier than a guess.
  const currentUsed = fresh ? fresh.used : 1;
  const currentWide = fresh ? fresh.wide : 1;
  const limit = blocked ? SPENT_LIMIT : settings.threshold;
  // A move a person asked for goes to the best account under the limit,
  // roomier than the one in use or not: they said to move.
  const hysteresis = forced ? -1 : blocked ? SPENT_HYSTERESIS : settings.hysteresis;

  for (const [name, mark] of Object.entries(state.full)) if (mark.until <= now) delete state.full[name];
  for (const [name, until] of Object.entries(state.failed)) if (until <= now) delete state.failed[name];

  const order = deps.order();
  let targetReads = 0;
  for (let attempt = 0; attempt < 2; ) {
    const target = pickTarget({
      current: current.name,
      candidates,
      currentUsed,
      currentWide,
      skipUntil: { ...state.failed, ...fullSkip(state.full, now, blocked) },
      sameLogin,
      limit,
      hysteresis,
      otherModels: blocked && currentWide >= 1,
      order,
      ...(settings.model ? { model: settings.model } : {}),
      now,
    });
    extras.target = target;

    if (target.name === null) {
      const stay = forced ? null : stayKind(fresh, settings.threshold);
      if (stay) {
        const why =
          stay === 'model-only'
            ? "only one model's own week is spent and no account is roomier; staying"
            : `${decision.why}, and no account has enough more room; staying`;
        once(stay, `${current.name}: ${why}`);
        state.none = { at: now, until: target.until, loose: blocked };
        state.lastWhy = why;
        return finish('stayed', why);
      }
      const why = `no account has room${target.until !== null ? ` (the soonest opens ${inWords(target.until - now)})` : ''}; staying on ${current.name}`;
      // Said once per incident. A spent pass after an early one is a new
      // incident: it asked with the looser bar, and still found nothing.
      const news = state.none === null || (blocked && !state.none.loose);
      if (news && !dry) {
        log(why);
        await quietly(() => deps.announce({ type: 'no-room', account: current.name, until: target.until }), undefined);
      }
      state.none = { at: now, until: target.until, loose: blocked };
      state.lastWhy = why;
      state.lastCat = 'no-room';
      return finish('no-room', why);
    }

    // ccx's number for the target can be one that failed to refresh and was
    // stamped as new. A move made on it lands on an account that filled up
    // since, and the next pass moves again. So the target is asked directly.
    const account = accounts.find((a) => a.name === target.name);
    if (account && deps.tokenLive(account)) {
      if (targetReads >= MAX_TARGET_READS) {
        log('eight targets read near their limits in one pass; staying until the next');
        state.none = { at: now, until: null, loose: blocked };
        state.lastCat = 'no-room';
        return finish('no-room', 'every target read was near its limit');
      }
      targetReads += 1;
      const read = await deps.read(account, 'target');
      state.counts = countRead(state.counts, 'target', read.ok ? 200 : read.status, now);
      if (read.ok) {
        if (!dry) deps.record(account.name, read.result, now);
        const wide = target.how === 'other-models';
        const used = wide ? wideUtilization(read.usage, now) : bindingUtilization(read.usage, settings.model, now);
        if (!fits(used, wide ? currentWide : currentUsed, limit, hysteresis)) {
          log(`${account.name}: a fresh read puts it near its limit too; trying the next account`);
          state.full[account.name] = { until: now + FULL_MS, loose: blocked };
          continue;
        }
      } else if (isRefusal(read.status)) {
        log(`${account.name}: its login is refused; leaving it out for two hours`);
        state.failed[account.name] = now + FAILED_MS;
        attempt += 1;
        continue;
      }
      // Rate limited or unreachable: ccx's own number stands.
    }

    attempt += 1;
    const reason = `${decision.kind}: ${decision.why}`;
    if (dry) return finish('would-switch', `would move ${current.name} to ${target.name} (${reason})`);

    const outcome = deps.switchTo(current.name, target.name, reason);
    if (outcome.code === 'busy') {
      once('busy', 'another switch is in progress; looking again on the next pass');
      return finish('busy', 'another switch is in progress');
    }
    if (outcome.code === 'changed') {
      return finish('stayed', `the account in use changed to ${outcome.active ?? 'none'} first; judging it on the next pass`);
    }
    if (outcome.code === 'failed') {
      log(`could not move to ${target.name}: ${outcome.why}`);
      state.failed[target.name] = now + FAILED_MS;
      state.lastCat = 'switch-failed';
      return finish('failed', outcome.why);
    }

    const pickRanOut = pick !== null && !forced;
    log(
      `moved ${current.name} to ${target.name} (${reason}${target.how === 'other-models' ? "; one model's own week is spent there" : ''}); ` +
        `${outcome.sessions} running session${outcome.sessions === 1 ? '' : 's'} asked to follow`,
    );
    if (pick !== null) deps.clearHandPick();
    state.lastSwitch = { at: now, from: current.name, to: target.name, kind: decision.kind, why: decision.why, by: options.by };
    if (decision.kind === 'dead' || decision.kind === 'blind') state.lastRiskyAt = now;
    state.account = { name: target.name, since: now };
    state.reads = [];
    state.none = null;
    state.refusals = null;
    state.lastFailure = null;
    state.lastWhy = null;
    state.lastCat = null;
    // Every session reads its usage on arriving somewhere new. Waiting 20 to
    // 60 seconds keeps the watcher from adding to that rush, which is what
    // gets a login rate limited.
    state.holdReadsUntil = now + 20_000 + Math.floor((deps.random ?? Math.random)() * 40_000);
    const followers = await quietly(() => deps.follow(current.name, target.name, decision.kind), []);
    const later = followers.filter((f) => !f.ok && f.retry).map((f) => f.host);
    state.follow =
      later.length > 0
        ? { from: current.name, to: target.name, kind: decision.kind, hosts: later, until: now + FOLLOW_FOR_MS, lastAt: now }
        : null;
    await quietly(
      () =>
        deps.announce({
          type: 'switched',
          kind: decision.kind,
          from: current.name,
          to: target.name,
          by: options.by,
          pickRanOut,
          followers,
        }),
      undefined,
    );
    return finish('switched', `moved ${current.name} to ${target.name}`);
  }

  state.lastCat = 'targets-refused';
  return finish('failed', 'the accounts tried were refused; looking again on the next pass');
}
