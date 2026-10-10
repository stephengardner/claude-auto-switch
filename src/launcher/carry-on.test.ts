import { describe, it, expect } from 'vitest';
import { createCarryOn, CARRY_ON_TIMING, type CarryOn, type CarryOnView } from './carry-on.js';

const T = { pickupMs: 1_000, settleMs: 200, submitMs: 500, answerMs: 800, blockedMs: 3_000 };
const MOVED = 10_000;

function carryOn(over: { stalled?: boolean; canRelaunch?: boolean } = {}): CarryOn {
  return createCarryOn({
    prompt: 'carry on',
    movedAt: MOVED,
    stalled: over.stalled ?? true,
    canRelaunch: over.canRelaunch ?? true,
    timing: T,
  });
}

/** Claude at an empty prompt, nobody at the keyboard, unless said otherwise. */
function view(now: number, over: Partial<CarryOnView> = {}): CarryOnView {
  return {
    now,
    status: { status: 'idle', forMs: 5_000 },
    lastKeyAt: 0,
    endedOnEnter: false,
    promptAt: 0,
    readsPastes: true,
    subagentWroteAt: 0,
    ...over,
  };
}

const READY = MOVED + T.pickupMs;

describe('when a carry-on prompt may be typed into a live session', () => {
  it('waits for Claude to pick the new login up, then types', () => {
    const c = carryOn();
    expect(c.step(view(MOVED + 1))).toEqual({ do: 'wait' });
    expect(c.step(view(READY - 1))).toEqual({ do: 'wait' });
    expect(c.step(view(READY))).toEqual({ do: 'type' });
  });

  it('waits that long by default for the longest Claude holds a login it has read', () => {
    // 2.1.296 keeps a login read from the macOS Keychain for 30 seconds.
    expect(CARRY_ON_TIMING.pickupMs).toBeGreaterThan(30_000);
  });

  it('types only at the prompt: never during a turn, a subagent run or a dialog', () => {
    for (const status of ['busy', 'waiting', 'something a later Claude says']) {
      const c = carryOn();
      expect(c.step(view(READY, { status: { status, forMs: 5_000 } })), status).toEqual({
        do: 'wait',
      });
    }
    // At the prompt with a background command running is still at the prompt.
    expect(carryOn().step(view(READY, { status: { status: 'shell', forMs: 5_000 } }))).toEqual({
      do: 'type',
    });
  });

  it('types only into a program that reads a marked paste as text', () => {
    expect(carryOn().step(view(READY, { readsPastes: false }))).toMatchObject({ do: 'relaunch' });
  });

  it('lets Claude settle at its prompt first', () => {
    const c = carryOn();
    expect(c.step(view(READY, { status: { status: 'idle', forMs: T.settleMs - 1 } }))).toEqual({
      do: 'wait',
    });
    expect(c.step(view(READY + 1, { status: { status: 'idle', forMs: T.settleMs } }))).toEqual({
      do: 'type',
    });
  });

  it('types once the turn or the subagents it was waiting on are done', () => {
    const c = carryOn();
    expect(c.step(view(READY + 60_000, { status: { status: 'busy', forMs: 60_000 } }))).toEqual({
      do: 'wait',
    });
    expect(c.step(view(READY + 600_000, { status: { status: 'idle', forMs: 300 } }))).toEqual({
      do: 'type',
    });
  });

  it('never types once somebody has pressed a key since the move', () => {
    const c = carryOn();
    const step = c.step(view(READY, { lastKeyAt: MOVED + 5 }));
    expect(step).toMatchObject({ do: 'done', outcome: 'attended' });
  });

  it('counts a key pressed in the very millisecond of the move as somebody there', () => {
    // Taken for a draft left behind instead, it would have the session
    // relaunched under the hands of the person typing.
    expect(carryOn().step(view(READY, { lastKeyAt: MOVED }))).toMatchObject({
      do: 'done',
      outcome: 'attended',
    });
  });

  it('types into a box emptied by the prompt the person last sent', () => {
    const c = carryOn();
    expect(c.step(view(READY, { lastKeyAt: 9_000, endedOnEnter: true, promptAt: 9_004 }))).toEqual({
      do: 'type',
    });
  });

  it('never types over a draft left in the box before the move', () => {
    // Stalled, and a relaunch would hand the prompt over: that is the way.
    expect(
      carryOn().step(view(READY, { lastKeyAt: 9_000, endedOnEnter: false, promptAt: 8_000 })),
    ).toMatchObject({
      do: 'relaunch',
    });
    // Enter was the last key, but Claude recorded no prompt for it: it chose a
    // completion or added a line, and what was typed is still in the box.
    expect(
      carryOn().step(view(READY, { lastKeyAt: 9_000, endedOnEnter: true, promptAt: 8_000 })),
    ).toMatchObject({
      do: 'relaunch',
    });
  });

  it('leaves a session alone rather than relaunch it when it was not stalled, or a relaunch would not say it', () => {
    const draft = { lastKeyAt: 9_000, endedOnEnter: false };
    expect(carryOn({ stalled: false }).step(view(READY, draft))).toMatchObject({
      do: 'done',
      outcome: 'left',
    });
    expect(carryOn({ canRelaunch: false }).step(view(READY, draft))).toMatchObject({
      do: 'done',
      outcome: 'left',
    });
  });

  it('is delivered once Claude records the prompt and is not refused', () => {
    const c = carryOn();
    c.typed(READY);
    expect(c.step(view(READY + 100))).toEqual({ do: 'wait' });
    // Recorded by Claude, at or after the moment it was typed.
    expect(c.step(view(READY + 400, { promptAt: READY + 20 }))).toEqual({ do: 'wait' });
    expect(c.step(view(READY + T.answerMs, { promptAt: READY + 20 }))).toMatchObject({
      do: 'done',
      outcome: 'delivered',
    });
  });

  it('does not take an older prompt for the one it typed', () => {
    const c = carryOn();
    c.typed(READY);
    expect(c.step(view(READY + T.submitMs, { promptAt: READY - 5_000 }))).toMatchObject({
      do: 'relaunch',
    });
  });

  it('hands it over by relaunch when Claude never takes what was typed', () => {
    const c = carryOn();
    c.typed(READY);
    expect(c.step(view(READY + T.submitMs - 1))).toEqual({ do: 'wait' });
    expect(c.step(view(READY + T.submitMs))).toMatchObject({ do: 'relaunch' });
  });

  it('types once more, after another wait, when the prompt is refused', () => {
    const c = carryOn();
    c.typed(READY);
    c.refused(READY + 300, READY + 20);
    expect(c.step(view(READY + 400, { promptAt: READY + 20 }))).toEqual({ do: 'wait' });
    expect(c.step(view(READY + 300 + T.pickupMs - 1, { promptAt: READY + 20 }))).toEqual({
      do: 'wait',
    });
    expect(c.step(view(READY + 300 + T.pickupMs, { promptAt: READY + 20 }))).toEqual({
      do: 'type',
    });
  });

  it('stops after the second refusal instead of typing for ever', () => {
    const c = carryOn();
    c.typed(READY);
    c.refused(READY + 300, READY + 20);
    const again = READY + 300 + T.pickupMs;
    expect(c.step(view(again))).toEqual({ do: 'type' });
    c.typed(again);
    c.refused(again + 300, again + 20);
    expect(c.step(view(again + 301))).toMatchObject({ do: 'relaunch' });
    // And when a relaunch would not say it either, it is left, not retried.
    const own = carryOn({ canRelaunch: false });
    own.typed(READY);
    own.refused(READY + 300, READY + 20);
    own.typed(again);
    own.refused(again + 300, again + 20);
    expect(own.step(view(again + 301))).toMatchObject({ do: 'done', outcome: 'left' });
  });

  it('does not type again on top of a prompt Claude never took', () => {
    // A refusal arrives, but what was typed is still sitting in the box.
    const c = carryOn();
    c.typed(READY);
    c.refused(READY + 100, READY - 5_000);
    expect(c.step(view(READY + 100 + T.pickupMs))).toMatchObject({ do: 'relaunch' });
  });

  it('counts a session as stalled once its main thread is refused', () => {
    // Started by a subagent's refusal: the main thread had not stopped. Then
    // it was refused too, so a draft in the way now means a relaunch.
    const c = carryOn({ stalled: false });
    c.refused(MOVED + 50, 0);
    expect(c.step(view(READY, { lastKeyAt: 9_000, endedOnEnter: false }))).toMatchObject({
      do: 'relaunch',
    });
  });

  it('gives a dialog time to close, then stops waiting on it', () => {
    const dialog = { status: { status: 'waiting', forMs: 100 } };
    const c = carryOn();
    expect(c.step(view(READY, dialog))).toEqual({ do: 'wait' });
    expect(c.step(view(READY + T.blockedMs - 1, dialog))).toEqual({ do: 'wait' });
    expect(c.step(view(READY + T.blockedMs, dialog))).toMatchObject({ do: 'relaunch' });

    // Closed in time: the count starts again if another opens.
    const closed = carryOn();
    expect(closed.step(view(READY, dialog))).toEqual({ do: 'wait' });
    expect(closed.step(view(READY + 100, { status: { status: 'busy', forMs: 1 } }))).toEqual({
      do: 'wait',
    });
    expect(closed.step(view(READY + T.blockedMs + 50, dialog))).toEqual({ do: 'wait' });

    // A session that was not stalled is left as it is.
    const note = carryOn({ stalled: false });
    note.step(view(READY, dialog));
    expect(note.step(view(READY + T.blockedMs, dialog))).toMatchObject({
      do: 'done',
      outcome: 'left',
    });
  });

  it('counts a turn that began after it was typed as Claude taking it', () => {
    // Should a later Claude record prompts another way, a session that is
    // working on what was typed is not relaunched for want of the record.
    const c = carryOn();
    c.typed(READY);
    const working = { status: { status: 'busy', forMs: 200 } };
    expect(c.step(view(READY + 250, working))).toEqual({ do: 'wait' });
    expect(c.step(view(READY + T.submitMs + T.answerMs, working))).toMatchObject({
      do: 'done',
      outcome: 'delivered',
    });
    // Busy since before it was typed says nothing about it.
    const other = carryOn();
    other.typed(READY);
    expect(
      other.step(view(READY + T.submitMs, { status: { status: 'idle', forMs: 5_000 } })),
    ).toMatchObject({
      do: 'relaunch',
    });
  });

  it('never relaunches during a turn or while a subagent runs', () => {
    const busy = { status: { status: 'busy', forMs: 60_000 } };
    // Refused twice, and now subagents are running: it waits for them.
    const c = carryOn();
    c.typed(READY);
    c.refused(READY + 300, READY + 20);
    const again = READY + 300 + T.pickupMs;
    c.step(view(again));
    c.typed(again);
    c.refused(again + 300, again + 20);
    expect(c.step(view(again + 400, busy))).toEqual({ do: 'wait' });
    expect(c.step(view(again + 60_000))).toMatchObject({ do: 'relaunch' });
    // Typed and never taken, while something else keeps Claude busy.
    const untaken = carryOn();
    untaken.typed(READY);
    expect(untaken.step(view(READY + T.submitMs, busy))).toEqual({ do: 'wait' });
  });

  it('never relaunches while a subagent is still writing, dialog or not', () => {
    // Behind a dialog Claude says "waiting" whatever else is running, so its
    // word alone would end a subagent mid-run. The subagent's own record
    // growing says it is running.
    const dialog = { status: { status: 'waiting', forMs: 100 } };
    const c = carryOn();
    c.step(view(READY, dialog));
    const late = READY + T.blockedMs;
    expect(c.step(view(late, { ...dialog, subagentWroteAt: late - 200 }))).toEqual({ do: 'wait' });
    expect(c.step(view(late + 500, { ...dialog, subagentWroteAt: late + 400 }))).toEqual({
      do: 'wait',
    });
    // Quiet for as long as a dialog is waited on: now it goes.
    expect(
      c.step(view(late + 400 + T.blockedMs, { ...dialog, subagentWroteAt: late + 400 })),
    ).toMatchObject({ do: 'relaunch' });
  });

  it('leaves it to the person even after a refusal, once they are typing', () => {
    const c = carryOn();
    c.typed(READY);
    c.refused(READY + 300, READY + 20);
    c.typed(READY + 2_000);
    c.refused(READY + 2_300, READY + 2_020);
    expect(c.step(view(READY + 2_400, { lastKeyAt: READY + 2_350 }))).toMatchObject({
      do: 'done',
      outcome: 'attended',
    });
  });

  it('remembers that the main thread stopped', () => {
    const c = carryOn({ stalled: false });
    expect(c.isStalled()).toBe(false);
    c.refused(MOVED + 50, 0);
    expect(c.isStalled()).toBe(true);
  });

  it('does not act on one unreadable look at what Claude is doing', () => {
    const c = carryOn();
    expect(c.step(view(READY, { status: null }))).toEqual({ do: 'wait' });
    expect(c.step(view(READY + 400))).toEqual({ do: 'type' });
    const gone = carryOn();
    gone.step(view(READY, { status: null }));
    expect(gone.step(view(READY + T.blockedMs, { status: null }))).toMatchObject({
      do: 'relaunch',
    });
  });
});
