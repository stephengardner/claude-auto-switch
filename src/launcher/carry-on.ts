import type { LiveStatus } from '../session/live-conversation.js';

/**
 * Handing a carry-on prompt to a LIVE session, by typing it.
 *
 * When an account runs out, ccx replaces the login under the running Claude
 * and everything in that session keeps going: its subagents, background
 * commands, monitors, scheduled loops. But the turn the limit refused has
 * ended, so the session sits at its prompt, and an unattended one stops there.
 * Ending Claude to relaunch it with the prompt gets it moving and loses all of
 * the above. ccx owns the pseudo-terminal Claude runs in, so it can type the
 * prompt instead.
 *
 * Typing into somebody's terminal is only right when every one of these holds,
 * and this file is the rule for when they do:
 *
 * 1. Claude is using the new login. Read from the 2.1.296 binary: before each
 *    request Claude looks at the login file in its config folder and reads it
 *    again when the file changed, so a login ccx wrote there is used by the
 *    very next request; a login Claude itself moved into the macOS Keychain is
 *    read through a cache it keeps for 30 seconds, dropped early when the
 *    file's time changes, which ccx does after every move. The prompt still
 *    waits out `pickupMs` first. That is a bound, not a signal, so the outcome is
 *    checked as well: a prompt that is refused although the new account has
 *    room is typed once more after another wait, and after a second refusal it
 *    is handed over by relaunch instead of typed for ever.
 * 2. Claude is at its prompt. Its own record says so ("idle", or "shell" while
 *    a background command runs); "busy" covers a turn AND a running subagent,
 *    and "waiting" a dialog, where keys mean something else entirely.
 * 3. The input box is empty. Either nobody has typed in this Claude at all, or
 *    the last key was the Enter that sends a prompt and Claude recorded a
 *    prompt since. A draft is never typed over, and once somebody presses a
 *    key after the move they are there to carry on themselves.
 *
 * When a session that is stalled cannot be typed into, the prompt goes the old
 * way, by relaunch. That happens only at the prompt or behind a dialog, and
 * never while a subagent's record is still growing, so it does not end a turn
 * or a subagent the way relaunching on every limit did. A subagent that writes
 * nothing for as long as a dialog is waited on (one long command) can still
 * be ended behind a dialog; nothing ccx can read says it is running.
 */

export interface CarryOnTiming {
  /** How long after the login was replaced before a prompt may be typed. */
  pickupMs: number;
  /** How long Claude must have been at its prompt before it is typed into. */
  settleMs: number;
  /** How long Claude has to record a typed prompt as submitted. */
  submitMs: number;
  /** How long after typing a refusal still counts as that prompt's. */
  answerMs: number;
  /** How long a dialog may stay open, or Claude's record unreadable, before giving up on typing. */
  blockedMs: number;
}

export const CARRY_ON_TIMING: CarryOnTiming = {
  pickupMs: 35_000,
  settleMs: 2_000,
  submitMs: 10_000,
  answerMs: 20_000,
  blockedMs: 60_000,
};

/** Typed at most this many times for one move. */
const MAX_ATTEMPTS = 2;

/** What is known at one look. Both clocks are this machine's. */
export interface CarryOnView {
  now: number;
  /** What Claude says it is doing; null when it does not say. */
  status: LiveStatus | null;
  /** When the person last pressed a key in this Claude; 0 for never. */
  lastKeyAt: number;
  /** Whether that key was the Enter that sends a prompt. */
  endedOnEnter: boolean;
  /** When Claude last recorded a prompt typed at its terminal; 0 for never. */
  promptAt: number;
  /** Whether Claude has asked the terminal to mark pastes (see paste-mode). */
  readsPastes: boolean;
  /** When a subagent's record was last seen to grow; 0 for never. */
  subagentWroteAt: number;
}

export type CarryOnStep =
  | { do: 'wait' }
  /** Type the prompt now, then call `typed`. */
  | { do: 'type' }
  /** Over: delivered, not needed because somebody is there, or left untyped. */
  | { do: 'done'; outcome: 'delivered' | 'attended' | 'left'; why: string }
  /** It cannot be typed safely and the session is stalled: relaunch to deliver it. */
  | { do: 'relaunch'; why: string };

export interface CarryOn {
  readonly prompt: string;
  step(view: CarryOnView): CarryOnStep;
  /** The prompt was just typed. */
  typed(now: number): void;
  /**
   * The main thread's turn was just refused. `promptAt` as in the view, read
   * no earlier than the refusal.
   */
  refused(now: number, promptAt: number): void;
  /** Whether the main thread has stopped on the limit (see CarryOnOptions.stalled). */
  isStalled(): boolean;
}

export interface CarryOnOptions {
  prompt: string;
  /** When the login under Claude was replaced. */
  movedAt: number;
  /**
   * The main thread stopped on the limit, so the session waits until it is
   * told to carry on. False when only a subagent met it.
   */
  stalled: boolean;
  /** Whether a relaunch would hand this prompt over (a run with a prompt of its own keeps that one). */
  canRelaunch: boolean;
  timing?: Partial<CarryOnTiming>;
}

export function createCarryOn(options: CarryOnOptions): CarryOn {
  const t = { ...CARRY_ON_TIMING, ...options.timing };
  let stalled = options.stalled;
  let typedAt: number | null = null;
  /** Claude took what was last typed as a prompt. */
  let taken = false;
  let attempts = 0;
  let notBefore = options.movedAt + t.pickupMs;
  let refusedTooOften = false;
  /** Since when Claude has been behind a dialog, or not saying what it is doing. */
  let blockedSince: number | null = null;

  const wait: CarryOnStep = { do: 'wait' };
  const giveUp = (why: string): CarryOnStep =>
    stalled && options.canRelaunch ? { do: 'relaunch', why } : { do: 'done', outcome: 'left', why };

  const decide = (view: CarryOnView): CarryOnStep => {
    if (typedAt !== null) {
      const busy = view.status?.status === 'busy';
      // Claude took it: its record shows the prompt, or a turn began after
      // it was typed, which is what a prompt does.
      if (view.promptAt >= typedAt || (busy && view.now - (view.status?.forMs ?? 0) >= typedAt))
        taken = true;
      if (!taken) {
        if (view.now - typedAt < t.submitMs) return wait;
        return giveUp('it was typed, but Claude did not take it as a prompt');
      }
      return view.now - typedAt >= t.answerMs
        ? { do: 'done', outcome: 'delivered', why: 'Claude took it and was not refused' }
        : wait;
    }
    if (view.lastKeyAt >= options.movedAt) {
      return { do: 'done', outcome: 'attended', why: 'somebody is at the keyboard' };
    }
    if (refusedTooOften)
      return giveUp('it was refused twice although the account it moved to has room');
    if (view.now < notBefore) return wait;
    if (view.status === null || view.status.status === 'waiting') {
      blockedSince ??= view.now;
      if (view.now - blockedSince < t.blockedMs) return wait;
      return giveUp(
        view.status === null
          ? 'Claude does not say what it is doing'
          : 'a dialog is open in Claude',
      );
    }
    blockedSince = null;
    const atPrompt = view.status.status === 'idle' || view.status.status === 'shell';
    if (!atPrompt || view.status.forMs < t.settleMs) return wait;
    const boxEmpty = view.lastKeyAt === 0 || (view.endedOnEnter && view.promptAt >= view.lastKeyAt);
    if (!boxEmpty) return giveUp('something is typed in the input box');
    return view.readsPastes ? { do: 'type' } : giveUp('Claude is not reading marked pastes');
  };

  return {
    prompt: options.prompt,
    step(view) {
      const step = decide(view);
      if (step.do !== 'relaunch') return step;
      // Never while Claude is busy: that is a turn, or a subagent, and ending
      // those is what typing the prompt exists to avoid. It waits them out.
      // Nor while a subagent's record is still growing, which says the same
      // where Claude's word cannot: behind a dialog it says only "waiting".
      const subagentWriting =
        view.subagentWroteAt > 0 && view.now - view.subagentWroteAt < t.blockedMs;
      return view.status?.status === 'busy' || subagentWriting ? wait : step;
    },
    typed(now) {
      typedAt = now;
      taken = false;
      attempts += 1;
    },
    refused(now, promptAt) {
      // Whatever started the move, the main thread has stopped on a refusal now.
      stalled = true;
      // Typed but never taken: it is still in the box, so it is not typed
      // again on top of itself. The submit deadline decides what happens.
      if (typedAt === null || !(taken || promptAt >= typedAt)) return;
      typedAt = null;
      notBefore = now + t.pickupMs;
      if (attempts >= MAX_ATTEMPTS) refusedTooOften = true;
    },
    isStalled: () => stalled,
  };
}
