import { describe, it, expect, afterEach } from 'vitest';
import { FAKE_ENV, PTY_AVAILABLE, launches, live, waitFor } from './typeable-claude.js';

/**
 * ccx ends Claude for two things besides a limit: a newer ccx taking the
 * session over, and a switch it cannot make in place (see
 * switch-in-session.test.ts for that path). Claude saying it is idle is not
 * enough for either: a person can be part-way through a prompt, and a
 * subagent can still be working. Here the newer ccx is always waiting, and
 * ccx counts 0.3 s alone as enough.
 */
describe.skipIf(!PTY_AVAILABLE && !process.env.CI)('handing an idle session to a newer ccx', () => {
  afterEach(() => {
    for (const name of FAKE_ENV) delete process.env[name];
  });

  /** Claude idle at its prompt for a minute already, ending by itself at `endsAtMs`. */
  const idleClaude = (
    endsAtMs: number,
    extra: Record<string, string> = {},
  ): Record<string, string> => ({
    FAKE_CLAUDE_IDLE_STATUS: '1',
    FAKE_CLAUDE_IDLE_MS: String(endsAtMs),
    ...extra,
  });

  it('hands it over when nobody is there (the control)', { timeout: 60_000 }, async () => {
    const session = live({
      env: idleClaude(8000),
      newerInstall: () => true,
      idleBeforeRestartMs: 300,
    });
    expect((await session.outcome).handover).toBe(true);
    expect(session.log().filter((e) => e.type === 'reread')).toEqual([]);
  });

  it('never hands it over while something is typed in it', { timeout: 60_000 }, async () => {
    // A draft in the box is lost when Claude is ended, however long ago it
    // was typed.
    let typed = false;
    const session = live({
      env: idleClaude(3500),
      newerInstall: () => typed,
      idleBeforeRestartMs: 300,
    });
    await waitFor('the launch', session.log, (log) => launches(log).length === 1);
    session.press('half a thought');
    typed = true;

    const outcome = await session.outcome;
    expect(outcome.handover).toBeUndefined();
    expect(session.log().filter((e) => e.type === 'reread')).toHaveLength(1);
  });

  it(
    'hands it over only once its subagents have stopped working',
    { timeout: 60_000 },
    async () => {
      // Claude says it is idle while a subagent's record is still growing.
      const session = live({
        env: idleClaude(9000, { FAKE_CLAUDE_SUBAGENT_WRITES_UNTIL_MS: '3000' }),
        newerInstall: () => true,
        idleBeforeRestartMs: 300,
      });
      expect((await session.outcome).handover).toBe(true);
      // It finished, which it could only report if nothing ended it first.
      expect(session.log().filter((e) => e.type === 'subagent-done')).toHaveLength(1);
    },
  );
});
