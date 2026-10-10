import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addCommand } from '../../src/commands/add.js';
import { runCommand } from '../../src/commands/run.js';
import { setActive } from '../../src/state/active.js';
import { writeSwitchRequest } from '../../src/state/switch-request.js';
import { loadConfig } from '../../src/config/config.js';
import { liveLeases } from '../../src/session/lease.js';
import { saveToken } from '../../src/daemon/token-store.js';
import { IN_PLACE_PROMPT } from '../../src/session/resume-prompt.js';
import type { CliContext } from '../../src/context.js';
import {
  FAKE_ENV,
  PROMPT,
  PTY_AVAILABLE,
  QUICK,
  TYPEABLE,
  fakeClaude,
  launches,
  prompts,
  readLog,
  waitFor,
} from './typeable-claude.js';

/**
 * A whole ccx session whose account runs out, against the fake claude as one
 * that can be typed into: which account it ends on, what it is told, what is
 * written to the ledger and the event log, and when it is relaunched instead.
 */

type Verdict = 'limited' | 'allowed' | 'unknown';

describe.skipIf(!PTY_AVAILABLE && !process.env.CI)(
  'a session whose account runs out (against fake-claude)',
  () => {
    const started: number[] = [];
    afterEach(() => {
      for (const name of FAKE_ENV) delete process.env[name];
      for (const pid of started.splice(0)) {
        try {
          process.kill(pid);
        } catch {
          /* already gone */
        }
      }
    });

    function makeContext(home: string): CliContext {
      const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
      let asked = 0;
      return {
        ctx,
        config: loadConfig(ctx),
        claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
        // A is out; wherever it moves has room.
        verifyCap: () => {
          asked += 1;
          return Promise.resolve<Verdict>(asked === 1 ? 'limited' : 'allowed');
        },
        carryOn: QUICK,
        out: () => {},
        err: () => {},
        json: false,
        quiet: false,
      };
    }

    async function loginAccount(context: CliContext, home: string, name: string): Promise<string> {
      const dir = path.join(home, 'profiles', name);
      await addCommand(context, name, { dir, login: false });
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }), 'utf8');
      return dir;
    }

    const eventsIn = (home: string): Array<{ msg: string; kind?: string; count?: number }> =>
      readFileSync(path.join(home, 'events.jsonl'), 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as { msg: string; kind?: string; count?: number });
    const capsIn = (home: string): string[] =>
      (
        JSON.parse(readFileSync(path.join(home, 'ledger.json'), 'utf8')) as {
          caps: Array<{ account: string }>;
        }
      ).caps.map((c) => c.account);

    async function twoAccounts(
      prefix: string,
    ): Promise<{ home: string; runsLog: string; context: CliContext }> {
      const home = mkdtempSync(path.join(tmpdir(), prefix));
      const runsLog = path.join(home, 'runs.jsonl');
      const context = makeContext(home);
      await loginAccount(context, home, 'A');
      await loginAccount(context, home, 'B');
      setActive('A', context.ctx);
      return { home, runsLog, context };
    }

    it(
      'keeps what Claude has running, moves in place, and is then told to carry on',
      { timeout: 60_000 },
      async () => {
        const { home, runsLog, context } = await twoAccounts('cas-in-place-');
        const childPid = path.join(home, 'child.pid');
        Object.assign(process.env, {
          ...TYPEABLE,
          FAKE_CLAUDE_RUNS_LOG: runsLog,
          FAKE_CLAUDE_IDLE_MS: '20000',
          FAKE_CLAUDE_REFUSE_AFTER_MS: '1500',
          // At its prompt with a background command running, as Claude says it.
          FAKE_CLAUDE_STATUS: 'shell',
          FAKE_CLAUDE_GRANDCHILD: childPid,
          FAKE_CLAUDE_EXIT_AFTER_PROMPTS: '1',
          FAKE_CLAUDE_EXIT_DELAY_MS: '1500',
        });

        const running = runCommand(context, []);
        const typed = await waitFor(
          'the carry-on prompt',
          () => prompts(readLog(runsLog)),
          (p) => p.length > 0,
        );
        const child = Number(readFileSync(childPid, 'utf8'));
        started.push(child);
        // What Claude started before the limit is still running after the move
        // and after the prompt: signal 0 only asks whether the process exists.
        expect(() => process.kill(child, 0)).not.toThrow();
        // While it runs, the session is announced on the account it moved to.
        expect(liveLeases(context.ctx).map((l) => l.account)).toEqual(['B']);
        expect(await running).toBe(0);

        const log = readLog(runsLog);
        // One Claude process from start to finish.
        expect(launches(log)).toHaveLength(1);
        expect(launches(log)[0]?.marker).toBe('A');
        expect(typed).toEqual([
          expect.objectContaining({
            text: IN_PLACE_PROMPT,
            marker: 'B',
            refused: false,
            pid: launches(log)[0]?.pid,
          }),
        ]);
        // One limit: recorded once, said once.
        expect(capsIn(home)).toEqual(['A']);
        const events = eventsIn(home);
        expect(events.filter((e) => e.kind === 'capped').map((e) => [e.msg, e.count ?? 1])).toEqual(
          [['A hit its limit', 1]],
        );
        expect(events.filter((e) => e.kind === 'cap-relief')).toHaveLength(1);
        expect(events.map((e) => e.msg)).toContain(
          'typed the carry-on prompt into the live session',
        );
        expect(events.map((e) => e.msg)).not.toContain(
          'relaunching instead of relieving in place: the carry-on prompt cannot be typed into this Claude',
        );
      },
    );

    it(
      "moves on a subagent's refusal: one limit, one cap, one event",
      { timeout: 60_000 },
      async () => {
        const { home, runsLog, context } = await twoAccounts('cas-in-place-subagent-');
        Object.assign(process.env, {
          ...TYPEABLE,
          FAKE_CLAUDE_RUNS_LOG: runsLog,
          FAKE_CLAUDE_IDLE_MS: '20000',
          FAKE_CLAUDE_SUBAGENT_REFUSE_AFTER_MS: '1500',
          // And the main thread meets it after the move, on the login it had.
          FAKE_CLAUDE_REFUSE_AFTER_MS: '3600',
          FAKE_CLAUDE_EXIT_AFTER_PROMPTS: '1',
        });

        expect(await runCommand(context, [])).toBe(0);

        const log = readLog(runsLog);
        expect(log.filter((e) => e.type === 'subagent-refusal')).toHaveLength(1);
        expect(launches(log)).toHaveLength(1);
        expect(prompts(log)).toEqual([
          expect.objectContaining({ text: IN_PLACE_PROMPT, marker: 'B', refused: false }),
        ]);
        expect(capsIn(home)).toEqual(['A']);
        const events = eventsIn(home);
        expect(events.filter((e) => e.kind === 'capped').map((e) => [e.msg, e.count ?? 1])).toEqual(
          [['A hit its limit', 1]],
        );
        expect(events.filter((e) => e.kind === 'cap-relief')).toHaveLength(1);
      },
    );

    it(
      'relaunches a moved session that cannot be typed into once its main thread stops',
      { timeout: 60_000 },
      async () => {
        // This Claude keeps no record of what it is doing. A subagent's
        // refusal moves it in place all the same; when the main thread is
        // then refused by a request it already had on its way, the relaunch
        // is what tells it to carry on, on the account it was moved to.
        const { home, runsLog, context } = await twoAccounts('cas-in-place-untypeable-');
        context.carryOn = { ...QUICK, blockedMs: 4000 };
        Object.assign(process.env, {
          ...TYPEABLE,
          FAKE_CLAUDE_STATUS: '',
          FAKE_CLAUDE_RUNS_LOG: runsLog,
          FAKE_CLAUDE_IDLE_MS: '20000',
          FAKE_CLAUDE_RESUMED_IDLE_MS: '600',
          FAKE_CLAUDE_SUBAGENT_REFUSE_AFTER_MS: '1000',
          FAKE_CLAUDE_REFUSE_AFTER_MS: '3200',
        });

        expect(await runCommand(context, [])).toBe(0);
        const log = readLog(runsLog);
        expect(launches(log).map((l) => l.marker)).toEqual(['A', 'B']);
        const relaunch = launches(log)[1]?.args ?? [];
        expect(relaunch).toContain('--resume');
        expect(relaunch.at(-1)).toMatch(/^This session was restarted/);
        expect(capsIn(home)).toEqual(['A']);
        const events = eventsIn(home);
        expect(events.filter((e) => e.kind === 'cap-relief')).toHaveLength(1);
        expect(events.filter((e) => e.kind === 'capped')).toHaveLength(1);
      },
    );

    it(
      "ends nothing and records nothing on a subagent's refusal with nowhere to move",
      { timeout: 60_000 },
      async () => {
        // The only account. The main thread has not stopped, so Claude runs
        // on, and the limit is written down when the main thread meets it.
        const home = mkdtempSync(path.join(tmpdir(), 'cas-in-place-nowhere-'));
        const runsLog = path.join(home, 'runs.jsonl');
        const context = makeContext(home);
        await loginAccount(context, home, 'A');
        setActive('A', context.ctx);
        Object.assign(process.env, {
          ...TYPEABLE,
          FAKE_CLAUDE_RUNS_LOG: runsLog,
          FAKE_CLAUDE_IDLE_MS: '4200',
          FAKE_CLAUDE_SUBAGENT_REFUSE_AFTER_MS: '1000',
        });

        expect(await runCommand(context, [])).toBe(0);
        const log = readLog(runsLog);
        expect(log.filter((e) => e.type === 'subagent-refusal')).toHaveLength(1);
        expect(launches(log)).toHaveLength(1);
        expect(existsSync(path.join(home, 'ledger.json')) ? capsIn(home) : []).toEqual([]);
        expect(
          eventsIn(home).filter((e) => e.kind === 'capped' || e.kind === 'cap-relief'),
        ).toEqual([]);
      },
    );

    it('types the prompt a session armed, as it was written', { timeout: 60_000 }, async () => {
      const { runsLog, context } = await twoAccounts('cas-in-place-armed-');
      Object.assign(process.env, {
        ...TYPEABLE,
        FAKE_CLAUDE_RUNS_LOG: runsLog,
        FAKE_CLAUDE_IDLE_MS: '20000',
        FAKE_CLAUDE_REFUSE_AFTER_MS: '1500',
        FAKE_CLAUDE_EXIT_AFTER_PROMPTS: '1',
      });

      expect(await runCommand(context, [], { resumePrompt: PROMPT })).toBe(0);
      const log = readLog(runsLog);
      expect(launches(log)).toHaveLength(1);
      expect(prompts(log)).toEqual([expect.objectContaining({ text: PROMPT, marker: 'B' })]);
    });

    it(
      'tells a run with a prompt of its own to carry on too, which a relaunch could not',
      { timeout: 60_000 },
      async () => {
        // Its own prompt rides every relaunch, so a relaunch never said anything
        // more and such a run was left idle after a move. Typed, it is told.
        const { home, runsLog, context } = await twoAccounts('cas-in-place-own-');
        Object.assign(process.env, {
          ...TYPEABLE,
          FAKE_CLAUDE_RUNS_LOG: runsLog,
          FAKE_CLAUDE_IDLE_MS: '20000',
          FAKE_CLAUDE_REFUSE_AFTER_MS: '1500',
          FAKE_CLAUDE_EXIT_AFTER_PROMPTS: '1',
        });

        expect(
          await runCommand(context, ['--dangerously-skip-permissions', 'fix the flaky test']),
        ).toBe(0);
        const log = readLog(runsLog);
        expect(launches(log)).toHaveLength(1);
        expect(prompts(log)).toEqual([
          expect.objectContaining({ text: IN_PLACE_PROMPT, marker: 'B' }),
        ]);
        expect(eventsIn(home).filter((e) => e.kind === 'cap-relief')).toHaveLength(1);
      },
    );

    it(
      'relaunches for the prompt on the account the person moved it to meanwhile',
      { timeout: 60_000 },
      async () => {
        // The limit moves it to B. While the prompt waits, the person moves it
        // to C from another terminal. A draft is in the box, so the prompt
        // goes by relaunch, and that relaunch must not put it back on B.
        const { home, runsLog, context } = await twoAccounts('cas-in-place-moved-');
        await loginAccount(context, home, 'C');
        // Long enough for the person's move to land before the prompt is due.
        context.carryOn = { ...QUICK, pickupMs: 3000 };
        Object.assign(process.env, {
          ...TYPEABLE,
          FAKE_CLAUDE_RUNS_LOG: runsLog,
          FAKE_CLAUDE_IDLE_MS: '20000',
          FAKE_CLAUDE_RESUMED_IDLE_MS: '600',
          FAKE_CLAUDE_REFUSE_AFTER_MS: '1500',
        });

        const running = runCommand(context, []);
        await waitFor(
          'the launch',
          () => launches(readLog(runsLog)),
          (l) => l.length === 1,
        );
        // Typed and left unsent, as the person's keys reach a session.
        process.stdin.emit('data', Buffer.from('half a thought'));
        await waitFor(
          'the move to B',
          () => (existsSync(path.join(home, 'events.jsonl')) ? eventsIn(home) : []),
          (events) => events.some((e) => e.kind === 'cap-relief'),
        );
        writeSwitchRequest('C', Date.now(), 'seamless', context.ctx);

        expect(await running).toBe(0);
        expect(launches(readLog(runsLog)).map((l) => l.marker)).toEqual(['A', 'C']);
      },
    );

    it(
      'says nothing when carrying on is turned off, and still moves in place',
      { timeout: 60_000 },
      async () => {
        const { home, runsLog, context } = await twoAccounts('cas-in-place-off-');
        context.config.resume.auto = false;
        Object.assign(process.env, {
          ...TYPEABLE,
          FAKE_CLAUDE_RUNS_LOG: runsLog,
          FAKE_CLAUDE_IDLE_MS: '5000',
          FAKE_CLAUDE_REFUSE_AFTER_MS: '1000',
        });

        expect(await runCommand(context, [])).toBe(0);
        const log = readLog(runsLog);
        expect(launches(log)).toHaveLength(1);
        expect(prompts(log)).toEqual([]);
        expect(log.filter((e) => e.type === 'reread').pop()?.marker).toBe('B');
        expect(eventsIn(home).filter((e) => e.kind === 'carry-on')).toEqual([]);
      },
    );

    it(
      'relaunches a Claude started with a token, which never reads the login in its folder',
      { timeout: 60_000 },
      async () => {
        // Claude uses a token in its environment whatever its folder holds, so
        // replacing the login there moves nothing: the session would stay on the
        // account that is out while ccx believed it had moved.
        const { home, runsLog, context } = await twoAccounts('cas-in-place-token-');
        saveToken(path.join(home, 'profiles', 'A'), 'sk-ant-oat01-not-a-real-token');
        Object.assign(process.env, {
          ...TYPEABLE,
          FAKE_CLAUDE_RUNS_LOG: runsLog,
          FAKE_CLAUDE_IDLE_MS: '20000',
          FAKE_CLAUDE_RESUMED_IDLE_MS: '600',
          FAKE_CLAUDE_REFUSE_AFTER_MS: '1500',
        });

        expect(await runCommand(context, [])).toBe(0);
        const log = readLog(runsLog);
        expect(launches(log).map((l) => [l.marker, l.oauthToken ?? null])).toEqual([
          ['A', 'sk-ant-oat01-not-a-real-token'],
          ['B', null],
        ]);
        expect(prompts(log)).toEqual([]);
        expect(eventsIn(home).filter((e) => e.kind === 'cap-relief')).toEqual([]);
        expect(capsIn(home)).toEqual(['A']);
      },
    );

    it(
      'relaunches onto an account that has only a token, which no folder can be handed',
      { timeout: 60_000 },
      async () => {
        // A token reaches Claude through a new launch's environment. Moved in
        // place onto such an account, the session's folder would hold no login.
        const home = mkdtempSync(path.join(tmpdir(), 'cas-in-place-token-only-'));
        const runsLog = path.join(home, 'runs.jsonl');
        const context = makeContext(home);
        await loginAccount(context, home, 'A');
        const dirB = path.join(home, 'profiles', 'B');
        await addCommand(context, 'B', { dir: dirB, login: false });
        mkdirSync(dirB, { recursive: true });
        saveToken(dirB, 'sk-ant-oat01-not-a-real-token');
        setActive('A', context.ctx);
        Object.assign(process.env, {
          ...TYPEABLE,
          FAKE_CLAUDE_RUNS_LOG: runsLog,
          FAKE_CLAUDE_IDLE_MS: '20000',
          FAKE_CLAUDE_RESUMED_IDLE_MS: '600',
          FAKE_CLAUDE_REFUSE_AFTER_MS: '1500',
        });

        expect(await runCommand(context, [])).toBe(0);
        const log = readLog(runsLog);
        expect(launches(log).map((l) => [l.marker, l.oauthToken ?? null])).toEqual([
          ['A', null],
          [null, 'sk-ant-oat01-not-a-real-token'],
        ]);
        expect(prompts(log)).toEqual([]);
        expect(eventsIn(home).filter((e) => e.kind === 'cap-relief')).toEqual([]);
      },
    );
  },
);
