import { closeSync, openSync, readSync, statSync } from 'node:fs';
import {
  clearCall,
  isDone,
  readAsks,
  sweepHops,
  writeState,
  type HopAsk,
  type HopEnd,
} from './hop-files.js';

/**
 * A session's temporary move to another account for one Artifact call, kept
 * by the ccx process that owns the session.
 *
 * The hook only asks and reports. This decides, moves the session through the
 * session's own in-place move, and moves it back: when the hook says the call
 * is over, when the call's result appears in the conversation's record, when
 * Claude ends, or when the move has been held for `holdMs`, whichever comes
 * first. So a hook that is killed, a call that fails with no hook after it,
 * and a Claude that never calls back all end with the session on its own
 * account.
 *
 * It never relaunches Claude and never touches which account is active. One
 * move is held at a time: a second request waits for the first to end.
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
  /** The session's in-place move. Throws when it could not be made. */
  activate: (account: A) => void;
  /**
   * `busy` while something else is deciding the session's account (a usage
   * limit being checked): the request waits. A reason when this session cannot
   * be moved in place at all: the request is refused with it.
   */
  standing: () => 'free' | 'busy' | { refuse: string };
  log: (message: string, data: Record<string, unknown>) => void;
  /** The longest a move is held with nothing saying the call is over. */
  holdMs?: number;
  /** How old a request can be before nobody is waiting for its answer any more. */
  askTtlMs?: number;
}

export interface HopController<A extends { name: string }> {
  /**
   * Take up the oldest request, when one is waiting and nothing stops it. True
   * while a move is held or being prepared, when no other move may start.
   */
  poll(): boolean;
  /** End the held move once it is over or out of time. */
  tick(): void;
  /** Claude ended: back at once, and nothing being prepared goes ahead. */
  childEnded(): void;
  /** The account the session left and the one it is on, while a move is held. */
  away(): { from: A; to: A } | null;
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

export function createHopController<A extends { name: string }>(deps: HopDeps<A>): HopController<A> {
  const now = deps.now ?? (() => Date.now());
  const holdMs = deps.holdMs ?? HOP_HOLD_MS;
  const askTtlMs = deps.askTtlMs ?? HOP_ASK_TTL_MS;

  let held: {
    ask: HopAsk;
    from: A;
    to: A;
    appliedAt: number;
    /** How far the conversation's record has been read for this call's result. */
    readFrom: number;
    /** Why it is ending, once it is: going back can fail, and is tried again on every tick. */
    ending: HopEnd | null;
  } | null = null;
  /** A login being renewed for a request, and how that came out once it has. */
  let preparing: { ask: HopAsk; to: A; result: { ok: true } | { ok: false; reason: string } | null } | null = null;
  /** When each finished move began and ended. */
  const windows: Array<{ from: number; to: number }> = [];
  let polls = 0;

  const refuse = (ask: HopAsk, reason: string): void => {
    writeState(deps.dir, { id: ask.id, state: 'refused', to: ask.to, reason, at: now() });
    clearCall(deps.dir, ask.id);
  };

  /** Move the session for `ask`, or refuse it. True when the move is now held. */
  const apply = (ask: HopAsk, to: A): boolean => {
    const from = deps.current();
    if (!from) {
      refuse(ask, 'ccx does not know which account this session is on, so it was not moved');
      return false;
    }
    if (from.name === to.name) {
      // Got there some other way since the hook looked. Nothing to hold or undo.
      writeState(deps.dir, { id: ask.id, state: 'applied', to: to.name, from: from.name, at: now(), moved: false });
      clearCall(deps.dir, ask.id);
      return false;
    }
    try {
      deps.activate(to);
    } catch (error) {
      refuse(ask, `ccx could not put this session on "${to.name}" (${(error as Error).message}), so the call was not sent`);
      return false;
    }
    const appliedAt = now();
    held = { ask, from, to, appliedAt, readFrom: ask.transcriptFrom ?? 0, ending: null };
    writeState(deps.dir, { id: ask.id, state: 'applied', to: to.name, from: from.name, at: appliedAt, moved: true });
    return true;
  };

  const finish = (by: HopEnd): void => {
    if (!held) return;
    const { ask, from, to, appliedAt } = held;
    // Something else moved the session meanwhile, and that move stands.
    const movedOn = deps.current()?.name !== to.name;
    if (!movedOn) {
      try {
        deps.activate(from);
      } catch (error) {
        if (held.ending === null) {
          held.ending = by;
          deps.log(`could not put this session back on "${from.name}" after an Artifact call; trying again`, {
            to: to.name,
            from: from.name,
            call: ask.id,
            error: (error as Error).message,
          });
        }
        return; // still away: every tick tries again
      }
    }
    const endedAt = now();
    held = null;
    windows.push({ from: appliedAt, to: endedAt });
    if (windows.length > WINDOWS_KEPT) windows.shift();
    writeState(deps.dir, { id: ask.id, state: 'ended', to: to.name, from: from.name, at: appliedAt, endedAt, by });
    clearCall(deps.dir, ask.id);
    const heldMs = endedAt - appliedAt;
    deps.log(
      by === 'deadline'
        ? `on "${to.name}" for one Artifact call, and nothing said the call was over; back on "${from.name}" after ${Math.round(heldMs / 1000)}s`
        : `on "${to.name}" for one Artifact call, then back on "${from.name}"`,
      { to: to.name, from: from.name, heldMs, endedBy: by, call: ask.id },
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
      if (held) return true;
      if (polls++ % 150 === 0) sweepHops(deps.dir, now(), ANSWER_KEPT_MS);

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
        if (deps.standing() !== 'free') return false;
        return apply(ask, to);
      }

      const ask = dropAbandoned(readAsks(deps.dir))[0];
      if (!ask) return false;
      const standing = deps.standing();
      if (standing === 'busy') return false;
      if (standing !== 'free') {
        refuse(ask, standing.refuse);
        return false;
      }
      const to = deps.account(ask.to);
      if (!to) {
        refuse(ask, `ccx has no account called "${ask.to}", so the call was not sent`);
        return false;
      }
      const readiness = deps.readiness(to);
      if (readiness === 'no-login') {
        refuse(ask, `"${to.name}" is not signed in, so the call was not sent. Ask the person to run: ccx login ${to.name}`);
        return false;
      }
      if (readiness === 'ready') return apply(ask, to);

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
      if (!held) return;
      if (held.ending !== null) return finish(held.ending);
      if (isDone(deps.dir, held.ask.id)) return finish('done');
      if (held.ask.transcript) {
        const look = resultRecorded(held.ask.transcript, held.readFrom, held.ask.id);
        held.readFrom = look.next;
        if (look.seen) return finish('result');
      }
      if (now() - held.appliedAt >= holdMs) finish('deadline');
    },

    childEnded() {
      if (preparing) {
        clearCall(deps.dir, preparing.ask.id);
        preparing = null;
      }
      finish('child-exit');
    },

    away() {
      return held ? { from: held.from, to: held.to } : null;
    },

    duringHop(at) {
      if (at === null) return false;
      if (held && at >= held.appliedAt) return true;
      return windows.some((w) => at >= w.from && at <= w.to);
    },
  };
}
