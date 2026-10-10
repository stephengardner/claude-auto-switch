import { closeSync, openSync, readSync, statSync } from 'node:fs';
import {
  clearCall,
  dropAsks,
  isDone,
  readAsks,
  removeAsk,
  sweepHops,
  writeState,
  type HopAsk,
  type HopEnd,
} from './hop-files.js';

/**
 * The account a session is held on for its Artifact calls, kept by the ccx
 * process that owns the session.
 *
 * Every routed call takes a hold on the account it must go out as, keyed by
 * its tool call id. When the session is on another account it is moved there
 * first, through the session's own in-place move; when it is already there,
 * Claude is still told to use the login in its folder now (it can be up to 30
 * seconds behind an ordinary move), and the hold keeps anything else from
 * moving it until the call is over. A second call for the same account joins
 * the hold that is there, and a call for another account waits for it. The
 * session goes back when the last hold ends: the hook says the call is over,
 * the call's result appears in the conversation's record, Claude ends, or the
 * hold has lasted `holdMs`, whichever comes first, so no hook has to run for
 * the session to come back. It never relaunches Claude and never touches
 * which account is active.
 */

export interface HopDeps<A extends { name: string }> {
  /** The session's folder, where the requests arrive. */
  dir: string;
  now?: () => number;
  /** The account the session is on. */
  current: () => A | null;
  /** A registered account by name, as the registry has it now. */
  account: (name: string) => A | null;
  /** Whether the account's login can be put under the running Claude as it is. */
  readiness: (account: A) => 'ready' | 'renewal-due' | 'no-login';
  /** Renew a login that is due, the way ccx renews an idle one. */
  renew: (account: A) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** The session's in-place move, for a call (`away`) or back after it. Throws when it could not be made. */
  activate: (account: A, trip: 'away' | 'back') => void;
  /** Make the running Claude use the login already in its folder from its next call. Throws when it cannot. */
  pin: (account: A) => void;
  /**
   * `busy` while something else is deciding the session's account (a usage
   * limit being checked): the request waits. A reason when the session cannot
   * be proven to be on `to` for a call: the request is refused with it.
   */
  standing: (to: A) => 'free' | 'busy' | { refuse: string };
  log: (message: string, data: Record<string, unknown>) => void;
  /** The longest a hold lasts with nothing saying its call is over, and the longest a move takes new calls. */
  holdMs?: number;
  /** How old a request can be before nobody is waiting for its answer any more. */
  askTtlMs?: number;
}

export interface HopController<A extends { name: string }> {
  /**
   * Take up waiting requests: join the hold that is there, or start one when
   * none is. True while a hold is in force or being prepared, when no other
   * move may start.
   */
  poll(): boolean;
  /** End holds that are over or out of time, and put the session back once the last one has. */
  tick(): void;
  /** Claude ended: every hold ends, the session goes back, and every request it made is dropped. */
  childEnded(): void;
  /** The account the session left and the one it is on, while it is moved for a call. */
  away(): { from: A; to: A } | null;
  /** Whether a call holds the session where it is, moved there or not: nothing else may move it meanwhile. */
  holding(): boolean;
  /**
   * Whether a refused turn recorded at `at` fell inside a move. Such a turn
   * was most likely refused by the account the session was visiting, so it
   * says nothing about the session's own.
   */
  duringHop(at: number | null): boolean;
}

/** Two minutes: long enough for a large page to upload or a person to answer a question, short enough to be a bound. */
export const HOP_HOLD_MS = 120_000;
/** Longer than the hook waits for an answer (hook.ts), so a request this old was given up on. */
export const HOP_ASK_TTL_MS = 60_000;
/** The most of the conversation's record read in one look for a call's result. */
const RESULT_READ_MAX = 4 * 1024 * 1024;
const WINDOWS_KEPT = 50;
/** How long an answer is kept for the hook that reads it after the call. */
const ANSWER_KEPT_MS = 10 * 60_000;

/** Whether the record gained the result of tool call `id` at or after byte `from`. */
function resultRecorded(file: string, from: number, id: string): { seen: boolean; next: number } {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return { seen: false, next: from };
  }
  if (size <= from) return { seen: false, next: Math.min(from, size) };
  const needle = `"tool_use_id":"${id}"`;
  const start = Math.max(from, size - RESULT_READ_MAX);
  let text: string;
  try {
    const fd = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      const read = readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.subarray(0, read).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return { seen: false, next: from };
  }
  if (text.includes(needle)) return { seen: true, next: size };
  // Far enough back that a result cut in two by this read is whole in the next.
  return { seen: false, next: Math.max(start, size - Buffer.byteLength(needle, 'utf8')) };
}

interface Hold {
  ask: HopAsk;
  at: number;
  /** How far the conversation's record has been read for this call's result. */
  readFrom: number;
}

interface Visit<A> {
  from: A;
  to: A;
  /** False when the session was on `to` already and was only held there. */
  moved: boolean;
  startedAt: number;
  holds: Map<string, Hold>;
  /** Holds that ended while the session was still needed on `to` by no one, waiting for it to be back. */
  ending: Array<{ id: string; at: number; by: HopEnd }>;
  calls: number;
  /** Going back was tried and failed; said once. */
  returnFailed: boolean;
}

export function createHopController<A extends { name: string }>(deps: HopDeps<A>): HopController<A> {
  const now = deps.now ?? (() => Date.now());
  const holdMs = deps.holdMs ?? HOP_HOLD_MS;
  const askTtlMs = deps.askTtlMs ?? HOP_ASK_TTL_MS;

  let visit: Visit<A> | null = null;
  /** A login being renewed for a request, and how that came out once it has. */
  let preparing: { ask: HopAsk; to: A; result: { ok: true } | { ok: false; reason: string } | null } | null = null;
  /** When each finished move began and ended. */
  const windows: Array<{ from: number; to: number }> = [];
  let polls = 0;

  const refuse = (ask: HopAsk, reason: string): void => {
    writeState(deps.dir, { id: ask.id, state: 'refused', to: ask.to, reason, at: now() });
    clearCall(deps.dir, ask.id);
  };

  const addHold = (v: Visit<A>, ask: HopAsk): void => {
    const at = now();
    v.holds.set(ask.id, { ask, at, readFrom: ask.transcriptFrom ?? 0 });
    v.calls += 1;
    writeState(deps.dir, { id: ask.id, state: 'applied', to: v.to.name, from: v.from.name, at, moved: v.moved });
    removeAsk(deps.dir, ask.id);
  };

  /** Start a hold for `ask` on `to`, moving the session there or telling Claude to use the login it has. */
  const startVisit = (ask: HopAsk, to: A): boolean => {
    const from = deps.current();
    if (!from) {
      refuse(ask, 'ccx does not know which account this session is on, so the call was not sent');
      return false;
    }
    const moved = from.name !== to.name;
    try {
      if (moved) deps.activate(to, 'away');
      else deps.pin(to);
    } catch (error) {
      refuse(
        ask,
        moved
          ? `ccx could not put this session on "${to.name}" (${(error as Error).message}), so the call was not sent`
          : `ccx could not make Claude use the "${to.name}" login (${(error as Error).message}), so the call was not sent`,
      );
      return false;
    }
    visit = { from, to, moved, startedAt: now(), holds: new Map(), ending: [], calls: 0, returnFailed: false };
    addHold(visit, ask);
    return true;
  };

  const release = (v: Visit<A>, id: string, by: HopEnd): void => {
    const hold = v.holds.get(id);
    if (!hold) return;
    v.holds.delete(id);
    if (v.holds.size > 0) {
      // The session stays for the others: this call's own hold is over now.
      writeState(deps.dir, { id, state: 'ended', to: v.to.name, from: v.from.name, at: hold.at, endedAt: now(), by });
      clearCall(deps.dir, id);
    } else {
      v.ending.push({ id, at: hold.at, by });
    }
  };

  /** With no hold left: put the session back, then tell the calls still waiting on that. */
  const finish = (): void => {
    const v = visit;
    if (!v || v.holds.size > 0) return;
    // Something else moved it meanwhile, and that move stands.
    if (v.moved && deps.current()?.name === v.to.name) {
      try {
        deps.activate(v.from, 'back');
      } catch (error) {
        if (!v.returnFailed) {
          v.returnFailed = true;
          deps.log(`could not put this session back on "${v.from.name}" after an Artifact call; trying again`, {
            to: v.to.name,
            from: v.from.name,
            error: (error as Error).message,
          });
        }
        return; // still away: every tick tries again
      }
    }
    const endedAt = now();
    visit = null;
    for (const e of v.ending) {
      writeState(deps.dir, { id: e.id, state: 'ended', to: v.to.name, from: v.from.name, at: e.at, endedAt, by: e.by });
      clearCall(deps.dir, e.id);
    }
    if (!v.moved) return;
    windows.push({ from: v.startedAt, to: endedAt });
    if (windows.length > WINDOWS_KEPT) windows.shift();
    const last = v.ending[v.ending.length - 1];
    const by = last?.by ?? 'done';
    const heldMs = endedAt - v.startedAt;
    const what = v.calls === 1 ? 'one Artifact call' : `${v.calls} Artifact calls`;
    deps.log(
      v.ending.some((e) => e.by === 'deadline')
        ? `on "${v.to.name}" for ${what}, and nothing said the call was over; back on "${v.from.name}" after ${Math.round(heldMs / 1000)}s`
        : `on "${v.to.name}" for ${what}, then back on "${v.from.name}"`,
      { to: v.to.name, from: v.from.name, heldMs, endedBy: by, call: last?.id ?? null, calls: v.calls },
    );
  };

  /** Requests nobody is waiting on any more: given up on, or too old. */
  const dropAbandoned = (asks: HopAsk[]): HopAsk[] =>
    asks.filter((ask) => {
      const abandoned = isDone(deps.dir, ask.id) || now() - ask.at > askTtlMs;
      if (abandoned) clearCall(deps.dir, ask.id);
      return !abandoned;
    });

  return {
    poll() {
      if (polls++ % 150 === 0) sweepHops(deps.dir, now(), ANSWER_KEPT_MS);
      const asks = dropAbandoned(readAsks(deps.dir));

      if (visit) {
        // A call for the account the session is held on shares the hold, while
        // the hold is young and not on its way back.
        const v = visit;
        if (v.holds.size > 0 && now() - v.startedAt < holdMs) {
          for (const ask of asks) if (ask.to === v.to.name) addHold(v, ask);
        }
        return true;
      }

      if (preparing) {
        if (preparing.result === null) return true;
        const { ask, to, result } = preparing;
        preparing = null;
        if (isDone(deps.dir, ask.id)) {
          clearCall(deps.dir, ask.id);
          return false;
        }
        if (!result.ok) {
          refuse(ask, result.reason);
          return false;
        }
        if (deps.readiness(to) !== 'ready') {
          refuse(ask, `the "${to.name}" login could not be made ready, so the call was not sent. Try again in a minute`);
          return false;
        }
        // Whatever began while the login was being renewed goes first.
        if (deps.standing(to) !== 'free') return false;
        return startVisit(ask, to);
      }

      const ask = asks[0];
      if (!ask) return false;
      const to = deps.account(ask.to);
      if (!to) {
        refuse(ask, `ccx has no account called "${ask.to}", so the call was not sent`);
        return false;
      }
      const standing = deps.standing(to);
      if (standing === 'busy') return false;
      if (standing !== 'free') {
        refuse(ask, standing.refuse);
        return false;
      }
      // Already there: its login is the one in the folder, so nothing needs renewing.
      if (deps.current()?.name === to.name) return startVisit(ask, to);
      const readiness = deps.readiness(to);
      if (readiness === 'no-login') {
        refuse(ask, `"${to.name}" is not signed in, so the call was not sent. Ask the person to run: ccx login ${to.name}`);
        return false;
      }
      if (readiness === 'ready') return startVisit(ask, to);

      const mine = { ask, to, result: null as { ok: true } | { ok: false; reason: string } | null };
      preparing = mine;
      deps.renew(to).then(
        (result) => {
          mine.result = result;
        },
        (error: unknown) => {
          mine.result = {
            ok: false,
            reason: `the "${to.name}" login could not be renewed (${(error as Error).message}), so the call was not sent`,
          };
        },
      );
      return true;
    },

    tick() {
      const v = visit;
      if (!v) return;
      if (v.holds.size > 0) {
        // Moved by something else (a usage limit, a switch): no hold can vouch for it now.
        if (deps.current()?.name !== v.to.name) {
          for (const id of [...v.holds.keys()]) release(v, id, 'moved');
        }
        for (const [id, hold] of [...v.holds]) {
          if (isDone(deps.dir, id)) {
            release(v, id, 'done');
            continue;
          }
          if (hold.ask.transcript) {
            const look = resultRecorded(hold.ask.transcript, hold.readFrom, id);
            hold.readFrom = look.next;
            if (look.seen) {
              release(v, id, 'result');
              continue;
            }
          }
          if (now() - hold.at >= holdMs) release(v, id, 'deadline');
        }
      }
      if (v.holds.size === 0) finish();
    },

    childEnded() {
      dropAsks(deps.dir);
      preparing = null;
      const v = visit;
      if (!v) return;
      for (const id of [...v.holds.keys()]) release(v, id, 'child-exit');
      finish();
    },

    away() {
      return visit && visit.moved ? { from: visit.from, to: visit.to } : null;
    },

    holding() {
      return visit !== null;
    },

    duringHop(at) {
      if (at === null) return false;
      if (visit && visit.moved && at >= visit.startedAt) return true;
      return windows.some((w) => at >= w.from && at <= w.to);
    },
  };
}
