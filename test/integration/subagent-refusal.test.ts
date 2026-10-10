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
 * A subagent meeting the usage limit starts the same move as the main thread
 * meeting it, and nothing else: it never ends Claude, which is what would lose
 * the other subagents. Driven through a pseudo-terminal against the fake
 * claude, which keeps each subagent's record where Claude 2.1.296 does.
 */

/**
 * The main thread refused while the account is still being asked about a
 * subagent's refusal. The live check is a request with an eight-second
 * timeout, so the main thread's refusal can land inside it or after it, and
 * what happens next must not depend on which.
 */
describe.skipIf(!PTY_AVAILABLE && !process.env.CI)(
  'a main-thread refusal that comes while a subagent refusal is being checked',
  () => {
    afterEach(() => {
      for (const name of FAKE_ENV) delete process.env[name];
    });

    // Subagent refused at 0.8 s, main thread at 2 s; Claude ends by itself at
    // 20 s, which the log shows as a "reread" the tests require to be absent.
    const env = {
      FAKE_CLAUDE_IDLE_MS: '20000',
      FAKE_CLAUDE_SUBAGENT_REFUSE_AFTER_MS: '800',
      FAKE_CLAUDE_REFUSE_AFTER_MS: '2000',
    };

    for (const [speed, verifyDelayMs] of [
      ['at once', 0],
      ['in 3 s', 3000],
    ] as const) {
      it(
        `gets its own decision when the session cannot be moved in place (account answers ${speed})`,
        { timeout: 60_000 },
        async () => {
          // No in-place destination: a model-only limit, a token launch, a
          // next account that must be renewed first. The subagent's refusal
          // ends nothing; the main thread's must still end and relaunch.
          const session = live({
            env,
            verifyDelayMs,
            verify: () => true,
            decide: (context) => (context.sidechain ? { kind: 'left' } : { kind: 'restart' }),
          });
          const outcome = await session.outcome;
          expect(outcome.kind).toBe('capped');
          expect(session.decisions.map((d) => d.sidechain)).toEqual([true, false]);
          // Ended by ccx on the refusal, not by Claude running out its time.
          expect(session.log().filter((e) => e.type === 'reread')).toEqual([]);
        },
      );

      it(
        `gets its own check when the subagent's is not confirmed (account answers ${speed})`,
        { timeout: 60_000 },
        async () => {
          // The subagent's refusal was about something the account does not
          // confirm (its own model, say). The main thread's is.
          const session = live({
            env,
            verifyDelayMs,
            verify: (asked) => asked > 1,
            decide: (context) => (context.sidechain ? { kind: 'left' } : { kind: 'restart' }),
          });
          expect((await session.outcome).kind).toBe('capped');
          expect(session.asked()).toBe(2);
          expect(session.decisions.map((d) => d.sidechain)).toEqual([false]);
          expect(session.log().filter((e) => e.type === 'reread')).toEqual([]);
        },
      );

      it(
        `is relaunched with the prompt when moved and it cannot be typed into (account answers ${speed})`,
        { timeout: 60_000 },
        async () => {
          // Moved on the subagent's refusal; the main thread was refused on
          // the old account too, so it is stalled, and this Claude cannot be
          // told so by typing.
          const session = live({
            env: { ...env, FAKE_CLAUDE_STATUS: '' },
            verifyDelayMs,
            verify: () => true,
          });
          expect(await session.outcome).toMatchObject({ kind: 'switch', switchTo: 'B' });
          expect(session.decisions.map((d) => d.sidechain)).toEqual([true]);
          expect(session.events.at(-1)).toMatchObject({ kind: 'relaunch' });
          expect(session.log().filter((e) => e.type === 'reread')).toEqual([]);
        },
      );
    }
  },
);

describe.skipIf(!PTY_AVAILABLE && !process.env.CI)("a subagent's refusal starts the move", () => {
  afterEach(() => {
    for (const name of FAKE_ENV) delete process.env[name];
  });

  it(
    'moves the session in place though its main thread was never refused',
    { timeout: 60_000 },
    async () => {
      const session = live({
        env: {
          FAKE_CLAUDE_IDLE_MS: '20000',
          FAKE_CLAUDE_SUBAGENT_REFUSE_AFTER_MS: '800',
          FAKE_CLAUDE_EXIT_AFTER_PROMPTS: '1',
        },
      });
      expect((await session.outcome).kind).toBe('ok');

      const log = session.log();
      expect(log.filter((e) => e.type === 'subagent-refusal')).toHaveLength(1);
      // Asked about once, moved once, as a subagent's: the same Claude throughout.
      expect(session.decisions).toEqual([
        { relieve: true, switching: false, sidechain: true, canType: true },
      ]);
      expect(launches(log)).toHaveLength(1);
      // And told, once it is at its prompt, that what the limit ended can be run again.
      expect(prompts(log)).toEqual([
        expect.objectContaining({ text: PROMPT, marker: 'B', refused: false }),
      ]);
    },
  );

  it(
    'relaunches a Claude that cannot be typed into once its main thread stops too',
    { timeout: 60_000 },
    async () => {
      // Moved on a subagent's refusal, with its main thread working. Then a
      // request the main thread already had on its way is refused: now it is
      // stalled, on an account with room, and nothing can be typed to tell it.
      const session = live({
        env: {
          FAKE_CLAUDE_IDLE_MS: '20000',
          FAKE_CLAUDE_STATUS: '',
          FAKE_CLAUDE_SUBAGENT_REFUSE_AFTER_MS: '800',
          FAKE_CLAUDE_REFUSE_AFTER_MS: '2700',
        },
        timing: { blockedMs: 4000 },
      });
      expect(await session.outcome).toMatchObject({ kind: 'switch', switchTo: 'B' });
      expect(session.decisions).toEqual([
        { relieve: true, switching: false, sidechain: true, canType: false },
      ]);
      expect(prompts(session.log())).toEqual([]);
      expect(session.events.map((e) => e.kind)).toEqual(['refused', 'relaunch']);
    },
  );

  it(
    'checks a refusal from the login Claude still held against the account it moved to',
    { timeout: 60_000 },
    async () => {
      // After a move Claude can keep the login it had for up to 30 s, so a
      // subagent can be refused as A after the session is on B. The check asks
      // the login now in the folder, B, which has room: nothing is recorded
      // against B and nothing moves again.
      const session = live({
        env: {
          FAKE_CLAUDE_IDLE_MS: '20000',
          FAKE_CLAUDE_SUBAGENT_REFUSE_AFTER_MS: '800',
          FAKE_CLAUDE_SUBAGENT_REFUSE_AGAIN_AFTER_MS: '3500',
          FAKE_CLAUDE_OLD_LOGIN_REQUESTS: '1',
          FAKE_CLAUDE_EXIT_AFTER_PROMPTS: '1',
        },
        verifyLogin: (login) => login === 'A',
        // Short, so the second refusal is checked rather than waved through.
        refuteBackoffMs: 500,
        timing: { pickupMs: 4000 },
      });
      expect((await session.outcome).kind).toBe('ok');

      const refused = session.log().filter((e) => e.type === 'subagent-refusal');
      expect(refused.map((e) => e.marker)).toEqual(['A', 'A']);
      expect(session.asked()).toBe(2);
      expect(session.decisions).toHaveLength(1);
      expect(prompts(session.log())).toEqual([
        expect.objectContaining({ marker: 'B', refused: false }),
      ]);
    },
  );

  it('is one limit when the main thread then meets it too', { timeout: 60_000 }, async () => {
    // The main thread's own request was already on its way on the old login.
    const session = live({
      env: {
        FAKE_CLAUDE_IDLE_MS: '20000',
        FAKE_CLAUDE_SUBAGENT_REFUSE_AFTER_MS: '800',
        FAKE_CLAUDE_REFUSE_AFTER_MS: '2700',
        FAKE_CLAUDE_EXIT_AFTER_PROMPTS: '1',
      },
    });
    expect((await session.outcome).kind).toBe('ok');

    expect(session.decisions).toHaveLength(1);
    expect(session.decisions[0]?.sidechain).toBe(true);
    expect(launches(session.log())).toHaveLength(1);
    expect(prompts(session.log())).toEqual([
      expect.objectContaining({ marker: 'B', refused: false }),
    ]);
  });

  it(
    'is not relaunched for the prompt: its main thread never stopped',
    { timeout: 60_000 },
    async () => {
      // A draft is in the box, so the prompt cannot be typed. A session
      // stalled on the limit would be relaunched to be told; this one is
      // working, and is left as it is.
      const session = live({
        env: { FAKE_CLAUDE_IDLE_MS: '6500', FAKE_CLAUDE_SUBAGENT_REFUSE_AFTER_MS: '1500' },
      });
      await waitFor('the launch', session.log, (log) => launches(log).length === 1);
      session.press('half a thought');

      expect((await session.outcome).kind).toBe('ok');
      expect(session.decisions).toHaveLength(1);
      expect(prompts(session.log())).toEqual([]);
      expect(session.events).toEqual([expect.objectContaining({ kind: 'done', outcome: 'left' })]);
    },
  );

  it('ends nothing when the session cannot be moved in place', { timeout: 60_000 }, async () => {
    // No account to move to, or a limit on one model: the caller leaves it.
    // The main thread has not stopped, and ending Claude would end the rest.
    const session = live({
      env: { FAKE_CLAUDE_IDLE_MS: '5000', FAKE_CLAUDE_SUBAGENT_REFUSE_AFTER_MS: '800' },
      decide: () => ({ kind: 'left' }),
      verify: () => true,
    });
    const outcome = await session.outcome;
    expect(outcome.kind).toBe('ok');
    expect(outcome.exitCode).toBe(0);
    expect(launches(session.log())).toHaveLength(1);
    expect(session.decisions).toHaveLength(1);
  });

  it('asks once about a limit that several subagents meet', { timeout: 60_000 }, async () => {
    // Subagents fail one after another on the same limit. The answer to the
    // first stands for the next: not another question to the account, and
    // not another decision, for each.
    const session = live({
      env: {
        FAKE_CLAUDE_IDLE_MS: '5500',
        FAKE_CLAUDE_SUBAGENT_REFUSE_AFTER_MS: '800',
        FAKE_CLAUDE_SUBAGENT_REFUSE_AGAIN_AFTER_MS: '2400',
      },
      decide: () => ({ kind: 'left' }),
      verify: () => true,
    });
    expect((await session.outcome).kind).toBe('ok');
    expect(session.log().filter((e) => e.type === 'subagent-refusal')).toHaveLength(2);
    expect(session.asked()).toBe(1);
    expect(session.decisions).toHaveLength(1);
  });

  it('does not make a session that ended look capped', { timeout: 60_000 }, async () => {
    // Claude ends just after a subagent was refused: closed, for all ccx
    // knows. A limit only a subagent met is no reason to start it again.
    const session = live({
      env: { FAKE_CLAUDE_IDLE_MS: '1100', FAKE_CLAUDE_SUBAGENT_REFUSE_AFTER_MS: '600' },
      verify: () => true,
    });
    expect((await session.outcome).kind).toBe('ok');
    expect(session.log().filter((e) => e.type === 'subagent-refusal')).toHaveLength(1);
  });
});
