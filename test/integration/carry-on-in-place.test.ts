import { describe, it, expect, afterEach } from 'vitest';
import {
  FAKE_ENV,
  PROMPT,
  PTY_AVAILABLE,
  launches,
  live,
  prompts,
  waitFor,
} from './typeable-claude.js';

/**
 * An account running out must not end what a session has running. ccx moves
 * the session to another account under the live Claude, and then types the
 * carry-on prompt into it, where it used to end Claude and relaunch it with
 * the prompt, losing every subagent, background command and scheduled loop.
 *
 * These drive real sessions through a pseudo-terminal against the fake claude,
 * which, like Claude 2.1.296, says what it is doing in its own record, asks
 * the terminal to mark pastes, takes a marked paste as text and sends its
 * input box on Enter. Nothing here runs against the real Claude or a real
 * limit.
 */

describe.skipIf(!PTY_AVAILABLE && !process.env.CI)(
  'a carry-on prompt typed into the live Claude',
  () => {
    afterEach(() => {
      for (const name of FAKE_ENV) delete process.env[name];
    });

    it(
      'is typed once Claude has moved, and answered on the account it moved to',
      { timeout: 60_000 },
      async () => {
        const session = live({
          env: {
            FAKE_CLAUDE_IDLE_MS: '20000',
            FAKE_CLAUDE_REFUSE_AFTER_MS: '800',
            FAKE_CLAUDE_EXIT_AFTER_PROMPTS: '1',
            FAKE_CLAUDE_EXIT_DELAY_MS: '3500',
          },
        });
        expect((await session.outcome).kind).toBe('ok');

        const log = session.log();
        // The same Claude throughout: nothing was ended to deliver it.
        expect(launches(log)).toHaveLength(1);
        expect(prompts(log)).toEqual([
          expect.objectContaining({
            text: PROMPT,
            marker: 'B',
            refused: false,
            pid: launches(log)[0]?.pid,
          }),
        ]);
        // It could be typed because this Claude says what it is doing and reads pastes.
        expect(session.decisions).toEqual([
          { relieve: true, switching: false, sidechain: false, canType: true },
        ]);
        expect(session.events.map((e) => e.kind)).toEqual(['typed', 'done']);
        expect(session.events[1]).toMatchObject({ outcome: 'delivered' });
      },
    );

    it(
      'waits for a running subagent to finish before it is typed',
      { timeout: 60_000 },
      async () => {
        // Claude says "busy" while a subagent runs, with its main thread at the
        // prompt or not. Nothing is typed until it says it is at its prompt.
        const session = live({
          env: {
            FAKE_CLAUDE_IDLE_MS: '20000',
            FAKE_CLAUDE_REFUSE_AFTER_MS: '800',
            FAKE_CLAUDE_STATUS: 'busy',
            FAKE_CLAUDE_STATUS_THEN: '4500:idle',
            FAKE_CLAUDE_EXIT_AFTER_PROMPTS: '1',
          },
        });
        expect((await session.outcome).kind).toBe('ok');

        const log = session.log();
        expect(launches(log)).toHaveLength(1);
        expect(prompts(log)).toEqual([
          expect.objectContaining({ text: PROMPT, marker: 'B', refused: false }),
        ]);
        const typedAt = log.findIndex((e) => e.type === 'prompt');
        const idleAt = log.findIndex((e) => e.type === 'status' && e.status === 'idle');
        expect(idleAt).toBeGreaterThanOrEqual(0);
        expect(typedAt).toBeGreaterThan(idleAt);
      },
    );

    it(
      'is never typed over a draft: a stalled session is relaunched with it instead',
      { timeout: 60_000 },
      async () => {
        const session = live({
          env: { FAKE_CLAUDE_IDLE_MS: '20000', FAKE_CLAUDE_REFUSE_AFTER_MS: '1500' },
        });
        await waitFor('the launch', session.log, (log) => launches(log).length === 1);
        // Typed and left unsent, before the limit is met.
        session.press('half a thought');

        // Ended at its prompt, to be relaunched on the account it was moved to.
        expect(await session.outcome).toMatchObject({ kind: 'switch', switchTo: 'B' });
        expect(prompts(session.log())).toEqual([]);
        expect(session.events).toEqual([expect.objectContaining({ kind: 'relaunch' })]);
      },
    );

    it(
      'is relaunched on the account the session is on now, not the one the move went to',
      { timeout: 60_000 },
      async () => {
        // Moved to B by the limit, then to C by the person from another
        // terminal, while the prompt waited. A relaunch for the prompt that
        // went to B would undo their move.
        const session = live({
          env: { FAKE_CLAUDE_IDLE_MS: '20000', FAKE_CLAUDE_REFUSE_AFTER_MS: '1500' },
          accountNow: () => 'C',
        });
        await waitFor('the launch', session.log, (log) => launches(log).length === 1);
        session.press('half a thought');

        expect(await session.outcome).toMatchObject({ kind: 'switch', switchTo: 'C' });
      },
    );

    it(
      'is left to the person once they press a key after the move',
      { timeout: 60_000 },
      async () => {
        const session = live({
          env: { FAKE_CLAUDE_IDLE_MS: '5000', FAKE_CLAUDE_REFUSE_AFTER_MS: '800' },
          // Long enough to press a key before it would be typed.
          timing: { pickupMs: 2500 },
        });
        await waitFor(
          'the move',
          () => session.decisions.length,
          (n) => n === 1,
        );
        session.press('x');

        expect((await session.outcome).kind).toBe('ok');
        expect(prompts(session.log())).toEqual([]);
        expect(session.events).toEqual([
          expect.objectContaining({ kind: 'done', outcome: 'attended' }),
        ]);
      },
    );

    it(
      'is typed once more when Claude was still on the login it had',
      { timeout: 60_000 },
      async () => {
        // The first request after the move still goes out on the old login, as one
        // Claude holds in a cache would: refused, though the new account has room.
        const session = live({
          env: {
            FAKE_CLAUDE_IDLE_MS: '20000',
            FAKE_CLAUDE_REFUSE_AFTER_MS: '800',
            FAKE_CLAUDE_OLD_LOGIN_REQUESTS: '1',
            FAKE_CLAUDE_EXIT_AFTER_PROMPTS: '1',
          },
        });
        expect((await session.outcome).kind).toBe('ok');

        const log = session.log();
        expect(launches(log)).toHaveLength(1);
        expect(prompts(log).map((p) => ({ marker: p.marker, refused: p.refused }))).toEqual([
          { marker: 'A', refused: true },
          { marker: 'B', refused: false },
        ]);
        expect(session.events.map((e) => e.kind).slice(0, 3)).toEqual([
          'typed',
          'refused',
          'typed',
        ]);
        // One limit, decided once: the refusal after the move started nothing new.
        expect(session.decisions).toHaveLength(1);
      },
    );

    it(
      'stops after a second refusal and is handed over by relaunch',
      { timeout: 60_000 },
      async () => {
        const session = live({
          env: {
            FAKE_CLAUDE_IDLE_MS: '20000',
            FAKE_CLAUDE_REFUSE_AFTER_MS: '800',
            FAKE_CLAUDE_OLD_LOGIN_REQUESTS: '9',
          },
        });
        expect(await session.outcome).toMatchObject({ kind: 'switch', switchTo: 'B' });

        // Typed twice, never a third time.
        expect(prompts(session.log()).map((p) => p.refused)).toEqual([true, true]);
        expect(session.events.map((e) => e.kind)).toEqual([
          'typed',
          'refused',
          'typed',
          'refused',
          'relaunch',
        ]);
      },
    );

    it(
      'is not typed behind a dialog: a stalled session is relaunched when it stays open',
      { timeout: 60_000 },
      async () => {
        const session = live({
          env: {
            FAKE_CLAUDE_IDLE_MS: '20000',
            FAKE_CLAUDE_REFUSE_AFTER_MS: '800',
            FAKE_CLAUDE_STATUS: 'waiting',
          },
        });
        expect(await session.outcome).toMatchObject({ kind: 'switch', switchTo: 'B' });
        expect(prompts(session.log())).toEqual([]);
        expect(session.events).toEqual([expect.objectContaining({ kind: 'relaunch' })]);
      },
    );

    it(
      'does not relaunch from behind a dialog while a subagent is still writing',
      { timeout: 60_000 },
      async () => {
        // Behind a dialog Claude says "waiting" and nothing about its
        // subagents. One whose record is still growing is running, and ending
        // Claude would end it: the relaunch waits until it has gone quiet.
        const session = live({
          env: {
            FAKE_CLAUDE_IDLE_MS: '20000',
            FAKE_CLAUDE_REFUSE_AFTER_MS: '800',
            FAKE_CLAUDE_STATUS: 'waiting',
            FAKE_CLAUDE_SUBAGENT_WRITES_UNTIL_MS: '5500',
          },
        });
        expect(await session.outcome).toMatchObject({ kind: 'switch', switchTo: 'B' });
        // It finished: without the wait Claude is ended three seconds earlier.
        expect(session.log().filter((e) => e.type === 'subagent-done')).toHaveLength(1);
      },
    );

    it(
      'says a Claude that does not say what it is doing cannot be typed into',
      { timeout: 60_000 },
      async () => {
        // A Claude that keeps no status in its record. The caller is told, so it
        // can relaunch as before rather than move the session and leave it idle.
        const session = live({
          env: {
            FAKE_CLAUDE_IDLE_MS: '20000',
            FAKE_CLAUDE_REFUSE_AFTER_MS: '800',
            FAKE_CLAUDE_STATUS: '',
          },
          decide: () => ({ kind: 'restart' }),
        });
        expect((await session.outcome).kind).toBe('capped');
        expect(session.decisions).toEqual([
          { relieve: true, switching: false, sidechain: false, canType: false },
        ]);
      },
    );

    it(
      'is typed before a newer ccx may take the idle session over',
      { timeout: 60_000 },
      async () => {
        // A newer ccx takes over a Claude that has been idle a while, and
        // resumes it with nothing said. This one is idle because it is waiting
        // to be told to carry on, and has been "idle" for a minute already.
        const session = live({
          env: {
            FAKE_CLAUDE_IDLE_MS: '20000',
            FAKE_CLAUDE_REFUSE_AFTER_MS: '800',
            FAKE_CLAUDE_IDLE_STATUS: '1',
            FAKE_CLAUDE_EXIT_AFTER_PROMPTS: '1',
          },
          // Long enough that an unguarded handover would come first.
          timing: { pickupMs: 2500 },
          newerInstall: (moved) => moved,
        });
        const outcome = await session.outcome;
        expect(outcome.handover).toBeUndefined();
        expect(prompts(session.log())).toEqual([
          expect.objectContaining({ text: PROMPT, marker: 'B', refused: false }),
        ]);
      },
    );
  },
);
