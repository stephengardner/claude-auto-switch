import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node-pty';
import { addCommand } from '../../src/commands/add.js';
import { runCommand } from '../../src/commands/run.js';
import { setActive } from '../../src/state/active.js';
import { writeSwitchRequest } from '../../src/state/switch-request.js';
import { loadConfig } from '../../src/config/config.js';
import { liveLeases } from '../../src/session/lease.js';
import type { CliContext } from '../../src/context.js';

const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until something is actually true, rather than for a fixed number of
 * milliseconds. A hosted runner under parallel load can be several times slower
 * than a laptop, and a test that guesses a duration fails there for reasons that
 * have nothing to do with the code. Returns the value so it can be asserted on.
 */
async function waitFor<T>(
  what: string,
  read: () => T,
  ok: (value: T) => boolean,
  timeoutMs = 8000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = read();
  while (Date.now() < deadline) {
    last = read();
    if (ok(last)) return last;
    await sleep(50);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}; last saw ${JSON.stringify(last)}`);
}

interface RunEntry {
  type: 'launch' | 'reread';
  args?: string[];
  marker: string | null;
}

type Verdict = 'limited' | 'allowed' | 'unknown';

function makeContext(home: string, verifyCap?: () => Promise<Verdict>): CliContext {
  // HOME/USERPROFILE point at the temp home so the shared-projects link targets
  // the test's own ~/.claude, never the real one.
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  return {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    // Default: the API refutes any cap-looking text (no network in tests).
    verifyCap: verifyCap ?? (() => Promise.resolve('allowed' as Verdict)),
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
  };
}

async function loginAccount(context: CliContext, home: string, name: string): Promise<void> {
  const dir = path.join(home, 'profiles', name);
  await addCommand(context, name, { dir, login: false });
  mkdirSync(dir, { recursive: true });
  // A credential file makes the account "usable"; its marker identifies which
  // account each launch (and each simulated re-read) actually saw.
  writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }), 'utf8');
}

function readRuns(runsLog: string): RunEntry[] {
  return readFileSync(runsLog, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as RunEntry);
}

/**
 * Wait until the session has actually STARTED before acting on it.
 *
 * A fixed sleep here was a race, and it lost: session start grew more work
 * (sweeping dead session directories, seeding settings, the first usage
 * refresh, carrying a renewed login in), so on a loaded machine the switch
 * request landed BEFORE the first launch and the session simply started on the
 * requested account. The test then failed for a reason that had nothing to do
 * with what it was checking. Waiting for the observable event instead makes it
 * immune to however long startup takes.
 */
async function firstLaunch(runsLog: string, timeoutMs = 20_000): Promise<RunEntry> {
  const launches = await waitFor(
    'the session to launch',
    () => {
      try {
        return readRuns(runsLog).filter((r) => r.type === 'launch');
      } catch {
        return []; // the log does not exist until the fake writes its first line
      }
    },
    (found) => found.length > 0,
    timeoutMs,
  );
  return launches[0]!;
}

/**
 * These tests drive a REAL pseudo-terminal, which is the only way to exercise
 * the switch machinery honestly. Some environments will not allocate one (the
 * hosted macOS runners refuse: `posix_spawnp failed`), and a test that cannot
 * run is not the same as a test that fails, so they are skipped there.
 *
 * Deliberately noisy about it: a silently skipped test reads as a passing one.
 */
let ptyProblem = '';
function canSpawnPty(): boolean {
  try {
    const probe = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });
    try {
      probe.kill();
    } catch {
      /* already gone */
    }
    return true;
  } catch (err) {
    // Recorded and printed, so a skip explains itself instead of leaving the
    // next person to guess (that guessing is what this file cost once already).
    ptyProblem = (err as Error).message;
    return false;
  }
}

const PTY_AVAILABLE = canSpawnPty();
if (!PTY_AVAILABLE) {
  console.warn(
    `[skipped] real-terminal switch tests: this machine would not open one (${ptyProblem}). ` +
      'The in-session switch paths are NOT covered here.',
  );
}

/**
 * The conversation a launch is in: the id it named on a fresh start, or the id
 * it resumed. A swap must land on the SAME one it started in.
 *
 * `--continue` used to be enough to assert here, but that only ever meant "the
 * most recent conversation in this directory", which is a different thread
 * whenever two sessions share a project. What matters is the identity.
 */
function conversationOf(args: string[] | undefined): string | null {
  const list = args ?? [];
  for (const flag of ['--session-id', '--resume']) {
    const i = list.indexOf(flag);
    if (i >= 0 && list[i + 1]) return list[i + 1] as string;
  }
  return null;
}

describe.skipIf(!PTY_AVAILABLE)('on-demand switch in a running session (against fake-claude)', () => {
  afterEach(() => {
    delete process.env.FAKE_CLAUDE_IDLE_MS;
    delete process.env.FAKE_CLAUDE_RUNS_LOG;
    delete process.env.FAKE_CLAUDE_EMIT_CAP;
    delete process.env.FAKE_CLAUDE_NO_CONVERSATION;
  });

  it('replayed cap text is refuted by the API check: no false cap, no cascade', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-nocascade-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_IDLE_MS = '600';
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;
    process.env.FAKE_CLAUDE_EMIT_CAP = '1'; // the run "replays" a prior cap message

    const verified: string[] = [];
    const context = makeContext(home, () => {
      verified.push('probe');
      return Promise.resolve('allowed'); // the API says: not actually limited
    });
    await loginAccount(context, home, 'A');
    await loginAccount(context, home, 'B');
    setActive('A', context.ctx);

    const exit = await runCommand(context, []);
    expect(exit).toBe(0); // ended normally on A, not "every account is capped" (exit 1)
    expect(verified.length).toBeGreaterThan(0); // the match TRIGGERED verification

    const launches = readRuns(runsLog).filter((r) => r.type === 'launch');
    expect(launches).toHaveLength(1); // no rotation -> no cascade
    const ledgerPath = path.join(home, 'ledger.json');
    const caps = existsSync(ledgerPath)
      ? ((JSON.parse(readFileSync(ledgerPath, 'utf8')) as { caps?: unknown[] }).caps ?? [])
      : [];
    expect(caps).toHaveLength(0); // nothing falsely marked capped
  });

  it('rotates when claude EXITS ITSELF on a verified cap (the session-limit exit flavor)', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-exitcap-'));
    const runsLog = path.join(home, 'runs.jsonl');
    // NO idle: the fake prints the cap message and exits immediately, exactly
    // what real claude does when the 5-hour session limit is hit.
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;
    process.env.FAKE_CLAUDE_EMIT_CAP = '1';

    let calls = 0;
    const context = makeContext(home, () => {
      calls += 1;
      // The first probe confirms the REAL cap on A; the replayed text on B is refuted.
      return Promise.resolve(calls === 1 ? 'limited' : 'allowed');
    });
    await loginAccount(context, home, 'A');
    await loginAccount(context, home, 'B');
    setActive('A', context.ctx);

    const exit = await runCommand(context, []);
    expect(exit).toBe(0);

    const launches = readRuns(runsLog).filter((r) => r.type === 'launch');
    expect(launches).toHaveLength(2); // did NOT terminate: rotated and continued
    expect(launches[0]?.marker).toBe('A');
    expect(launches[1]?.marker).toBe('B');
    // The SAME conversation, by id, not merely "the most recent one here".
    expect(conversationOf(launches[1]?.args)).toBe(conversationOf(launches[0]?.args));
    expect(conversationOf(launches[1]?.args)).not.toBeNull();
    expect(launches[1]?.args).toContain('--resume');
    const caps = (JSON.parse(readFileSync(path.join(home, 'ledger.json'), 'utf8')) as {
      caps: Array<{ account: string }>;
    }).caps;
    expect(caps.map((c) => c.account)).toEqual(['A']);
  });

  it('a VERIFIED cap rotates once and continues on the next account', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-realcap-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_IDLE_MS = '2500';
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;
    process.env.FAKE_CLAUDE_EMIT_CAP = '1'; // every launch renders the cap text

    // First probe confirms a REAL cap (on A); after rotating, the replayed text
    // on B is refuted. This is exactly the real-world sequence.
    let calls = 0;
    const context = makeContext(home, () => {
      calls += 1;
      return Promise.resolve(calls === 1 ? 'limited' : 'allowed');
    });
    await loginAccount(context, home, 'A');
    await loginAccount(context, home, 'B');
    setActive('A', context.ctx);

    const exit = await runCommand(context, []);
    expect(exit).toBe(0);

    const launches = readRuns(runsLog).filter((r) => r.type === 'launch');
    expect(launches).toHaveLength(2); // one rotation, then stable
    expect(launches[0]?.marker).toBe('A');
    expect(launches[1]?.marker).toBe('B');
    // Same conversation, identified rather than guessed at.
    expect(conversationOf(launches[1]?.args)).toBe(conversationOf(launches[0]?.args));
    expect(launches[1]?.args).toContain('--resume');
    const caps = (JSON.parse(readFileSync(path.join(home, 'ledger.json'), 'utf8')) as {
      caps: Array<{ account: string }>;
    }).caps;
    expect(caps.map((c) => c.account)).toEqual(['A']); // only the real cap recorded
  });

  it('seamless (default): swaps the credential file in place, no relaunch', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-seamless-'));
    const runsLog = path.join(home, 'runs.jsonl');
    // A generous idle so the swap poll fires well before the run ends, even under
    // parallel-suite CPU load (keeps this timing test from flaking).
    process.env.FAKE_CLAUDE_IDLE_MS = '2500';
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;

    const context = makeContext(home);
    await loginAccount(context, home, 'A');
    await loginAccount(context, home, 'B');
    setActive('A', context.ctx);

    const running = runCommand(context, []);
    // The session must be RUNNING before it can be switched in place; a fixed
    // sleep raced startup and lost, and the session then simply started on B.
    await firstLaunch(runsLog);
    writeSwitchRequest('B', Date.now(), 'seamless', context.ctx);
    expect(await running).toBe(0);

    const runs = readRuns(runsLog);
    const launches = runs.filter((r) => r.type === 'launch');
    expect(launches).toHaveLength(1); // NO relaunch: same process throughout
    expect(launches[0]?.marker).toBe('A'); // launched on A
    // The seamless swap fired (deterministic: logged to the event stream)...
    const events = readFileSync(path.join(home, 'events.jsonl'), 'utf8');
    expect(events).toContain('switching to \\"B\\"');
    // ...and it swapped the credential file to B underneath the running process
    // (the simulated ~30s re-read at run's end sees B), with no restart.
    const lastReread = runs.filter((r) => r.type === 'reread').pop();
    expect(lastReread?.marker).toBe('B');
  });

  it('announces the account in use while it runs, and stops when it ends', async () => {
    // The protection that stops ccx signing you out mid-session: while a session
    // runs, its account must be visible to anything that renews logins, because
    // renewing REPLACES a login and would retire the token this session holds.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-lease-live-'));
    process.env.FAKE_CLAUDE_IDLE_MS = '2500';

    const context = makeContext(home);
    await loginAccount(context, home, 'A');
    setActive('A', context.ctx);

    const running = runCommand(context, []);
    const during = await waitFor(
      'the session to announce account A',
      () => liveLeases(context.ctx),
      (leases) => leases.length === 1 && leases[0]?.account === 'A',
    );
    expect(during.map((l) => l.account)).toEqual(['A']);
    // It must point at the folder the session actually reads its login from, so
    // usage can be read from the live copy rather than the stale stored one.
    expect(existsSync(path.join(during[0]?.configDir ?? '', '.credentials.json'))).toBe(true);

    // And it must keep SAYING so. An announcement that is written once and never
    // refreshed goes stale on its own, and the protection lapses with it while the
    // session is still running.
    const firstSeen = during[0]?.at ?? 0;
    const refreshed = await waitFor(
      'the announcement to be refreshed',
      () => liveLeases(context.ctx)[0]?.at ?? 0,
      (at) => at > firstSeen,
      4000,
    );
    expect(refreshed).toBeGreaterThan(firstSeen);

    expect(await running).toBe(0);
    // Released on the way out, so an idle account is not protected forever.
    expect(liveLeases(context.ctx)).toEqual([]);
  });

  it('ends with the login saved back and the announcement given up', async () => {
    // The ORDER of those two is pinned by handoff.test.ts, which can see the
    // sequence; this only checks the end state a real session leaves behind.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-lease-shutdown-'));
    process.env.FAKE_CLAUDE_IDLE_MS = '400';
    const context = makeContext(home);
    await loginAccount(context, home, 'A');
    setActive('A', context.ctx);

    expect(await runCommand(context, [])).toBe(0);
    // By the end, the announcement is gone AND the profile holds the session's
    // login, which is only consistent with saving before releasing.
    expect(liveLeases(context.ctx)).toEqual([]);
    expect(existsSync(path.join(home, 'profiles', 'A', '.credentials.json'))).toBe(true);
  });

  it('moves the announcement with a seamless switch, so only the live account is protected', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-lease-switch-'));
    process.env.FAKE_CLAUDE_IDLE_MS = '3000';

    const context = makeContext(home);
    await loginAccount(context, home, 'A');
    await loginAccount(context, home, 'B');
    setActive('A', context.ctx);

    const running = runCommand(context, []);
    await waitFor(
      'A to be announced',
      () => liveLeases(context.ctx).map((l) => l.account),
      (names) => names.join() === 'A',
    );
    writeSwitchRequest('B', Date.now(), 'seamless', context.ctx);
    // Exactly one, and it is B: the account left behind must be renewable again.
    const after = await waitFor(
      'the announcement to move to B',
      () => liveLeases(context.ctx).map((l) => l.account),
      (names) => names.join() === 'B',
    );
    expect(after).toEqual(['B']);

    expect(await running).toBe(0);
    expect(liveLeases(context.ctx)).toEqual([]);
  });

  it('force-now (restart): relaunches on the picked account with --continue', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-forcenow-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_IDLE_MS = '2500'; // generous margin so the poll fires under load
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;

    const context = makeContext(home);
    await loginAccount(context, home, 'A');
    await loginAccount(context, home, 'B');
    setActive('A', context.ctx);

    const running = runCommand(context, []);
    await firstLaunch(runsLog); // same race as the seamless case
    writeSwitchRequest('B', Date.now(), 'restart', context.ctx);
    expect(await running).toBe(0);

    const launches = readRuns(runsLog).filter((r) => r.type === 'launch');
    expect(launches).toHaveLength(2); // ended and relaunched
    expect(launches[0]?.marker).toBe('A');
    expect(launches[0]?.args).not.toContain('--continue');
    expect(launches[0]?.args).not.toContain('--resume');
    expect(launches[1]?.marker).toBe('B'); // relaunched on B
    // Same conversation, identified rather than guessed at.
    expect(conversationOf(launches[1]?.args)).toBe(conversationOf(launches[0]?.args));
    expect(launches[1]?.args).toContain('--resume');
  });

  it('starts on an account that still has the MODEL in use, not merely a working one', async () => {
    // The operator's case, end to end through the real session path: a Fable
    // session must skip an account whose Fable is spent, even though that
    // account is otherwise perfectly healthy and comes first by priority.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-model-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_IDLE_MS = '600';
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;

    const context = makeContext(home);
    await loginAccount(context, home, 'fable-spent');
    await loginAccount(context, home, 'fable-free');
    setActive('fable-spent', context.ctx);

    // The session is pinned to Fable, the way a real one is. The folder is made
    // here because the run creates it, and seedSettings leaves an existing file
    // alone, so this is the pin a real session would already have.
    mkdirSync(path.join(home, 'session'), { recursive: true });
    writeFileSync(
      path.join(home, 'session', 'settings.json'),
      JSON.stringify({ model: 'claude-fable-5[1m]' }),
      'utf8',
    );
    const now = Date.now();
    const usage = (fable: number) => ({
      fiveHour: 0.1,
      sevenDay: 0.2,
      fiveHourReset: now + 3600_000,
      sevenDayReset: now + 86_400_000,
      models: [{ name: 'Fable', utilization: fable, resetsAt: now + 86_400_000 }],
      at: now,
    });
    writeFileSync(
      path.join(home, 'usage-snapshot.json'),
      JSON.stringify({ accounts: { 'fable-spent': usage(1), 'fable-free': usage(0.1) } }),
      'utf8',
    );

    expect(await runCommand(context, [])).toBe(0);

    const launches = readRuns(runsLog).filter((r) => r.type === 'launch');
    expect(launches).toHaveLength(1);
    // NOT the pinned account: its Fable is gone, so starting there would hit the
    // limit immediately, which is the whole point of the feature.
    expect(launches[0]?.marker).toBe('fable-free');
  });

  it('starts on the pinned account when it still has the model', async () => {
    // The other half: model preference must not drag a session off an account
    // that is perfectly usable, or it would be churning for no reason.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-model-stay-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_IDLE_MS = '600';
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;

    const context = makeContext(home);
    await loginAccount(context, home, 'pinned');
    await loginAccount(context, home, 'other');
    setActive('pinned', context.ctx);
    mkdirSync(path.join(home, 'session'), { recursive: true });
    writeFileSync(
      path.join(home, 'session', 'settings.json'),
      JSON.stringify({ model: 'claude-fable-5[1m]' }),
      'utf8',
    );
    const now = Date.now();
    const usage = (fable: number) => ({
      fiveHour: 0,
      sevenDay: 0,
      fiveHourReset: null,
      sevenDayReset: null,
      models: [{ name: 'Fable', utilization: fable, resetsAt: null }],
      at: now,
    });
    writeFileSync(
      path.join(home, 'usage-snapshot.json'),
      // The other account has MORE room, and that is deliberately not a reason
      // to move: staying put beats churn.
      JSON.stringify({ accounts: { pinned: usage(0.7), other: usage(0.01) } }),
      'utf8',
    );

    expect(await runCommand(context, [])).toBe(0);
    const launches = readRuns(runsLog).filter((r) => r.type === 'launch');
    expect(launches[0]?.marker).toBe('pinned');
  });

  it('APPLIES the fallback model, not just announces it', async () => {
    // Choosing a model and not applying it is worse than not choosing one: the
    // session would keep running the model that just ran out while the operator
    // has been told it moved. So the launch itself must carry it.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-model-apply-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_IDLE_MS = '600';
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;

    const context = makeContext(home);
    await loginAccount(context, home, 'only');
    setActive('only', context.ctx);
    mkdirSync(path.join(home, 'session'), { recursive: true });
    writeFileSync(
      path.join(home, 'session', 'settings.json'),
      JSON.stringify({ model: 'claude-fable-5[1m]' }),
      'utf8',
    );
    const now = Date.now();
    writeFileSync(
      path.join(home, 'usage-snapshot.json'),
      JSON.stringify({
        accounts: {
          only: {
            fiveHour: 0.1,
            sevenDay: 0.2,
            fiveHourReset: null,
            sevenDayReset: null,
            // Fable gone, so the only way to work is another model.
            models: [{ name: 'Fable', utilization: 1, resetsAt: null }],
            at: now,
          },
        },
      }),
      'utf8',
    );

    expect(await runCommand(context, [])).toBe(0);

    const launches = readRuns(runsLog).filter((r) => r.type === 'launch');
    expect(launches).toHaveLength(1);
    const args = launches[0]?.args ?? [];
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
  });

  it('keeps the fallback model on the fresh retry after a failed resume', async () => {
    // The retry used to reuse the ORIGINAL args, so a session that had just
    // moved Fable-to-Opus restarted on Fable: straight back into the limit it
    // had rotated away from.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-model-retry-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_IDLE_MS = '600';
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;
    process.env.FAKE_CLAUDE_NO_CONVERSATION = '1';

    const context = makeContext(home);
    await loginAccount(context, home, 'only');
    setActive('only', context.ctx);
    mkdirSync(path.join(home, 'session'), { recursive: true });
    writeFileSync(
      path.join(home, 'session', 'settings.json'),
      JSON.stringify({ model: 'claude-fable-5[1m]' }),
      'utf8',
    );
    const now = Date.now();
    writeFileSync(
      path.join(home, 'usage-snapshot.json'),
      JSON.stringify({
        accounts: {
          only: {
            fiveHour: 0.1,
            sevenDay: 0.2,
            fiveHourReset: null,
            sevenDayReset: null,
            models: [{ name: 'Fable', utilization: 1, resetsAt: null }],
            at: now,
          },
        },
      }),
      'utf8',
    );

    // --continue is what makes the fake report nothing to resume.
    expect(await runCommand(context, ['--continue'])).toBe(0);

    const launches = readRuns(runsLog).filter((r) => r.type === 'launch');
    // The resume attempt, then the fresh retry.
    expect(launches.length).toBeGreaterThanOrEqual(2);
    const retry = launches[launches.length - 1]?.args ?? [];
    expect(retry).toContain('--model');
    expect(retry[retry.indexOf('--model') + 1]).toBe('opus');
    // And it really is the FRESH one, not another resume.
    expect(retry).not.toContain('--continue');
    expect(retry).not.toContain('--resume');
    // It NAMES the new conversation, so the next swap resumes this one rather
    // than the id that has just been shown to lead nowhere.
    const newId = conversationOf(retry);
    expect(newId).not.toBeNull();
    // And the RECORDED id is replaced too. That file is read in preference to
    // the planned one, so leaving the failed id there would send the very next
    // swap straight back to the conversation that does not exist.
    const recorded = path.join(home, 'sessions', String(process.pid), 'conversation.json');
    if (existsSync(recorded)) {
      expect((JSON.parse(readFileSync(recorded, 'utf8')) as { id: string }).id).toBe(newId);
    }
  });

  it('does NOT move off a model whose limit has already reset', async () => {
    // Taken from a real snapshot: Fable recorded at 100% with a reset time that
    // has since passed. The window reopened, so moving the session to Opus and
    // announcing a Fable limit would both be wrong.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-model-expired-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_IDLE_MS = '600';
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;

    const context = makeContext(home);
    await loginAccount(context, home, 'pinned');
    // A second, obviously usable account, so a wrong rotation has somewhere to
    // go and the test can actually catch it.
    await loginAccount(context, home, 'spare');
    setActive('pinned', context.ctx);
    mkdirSync(path.join(home, 'session'), { recursive: true });
    writeFileSync(
      path.join(home, 'session', 'settings.json'),
      JSON.stringify({ model: 'claude-fable-5[1m]' }),
      'utf8',
    );
    const now = Date.now();
    writeFileSync(
      path.join(home, 'usage-snapshot.json'),
      JSON.stringify({
        accounts: {
          pinned: {
            fiveHour: 0.07,
            sevenDay: 0,
            fiveHourReset: null,
            sevenDayReset: null,
            models: [{ name: 'Fable', utilization: 1, resetsAt: now - 3_600_000 }],
            at: now - 6_000_000,
          },
          spare: {
            fiveHour: 0,
            sevenDay: 0,
            fiveHourReset: null,
            sevenDayReset: null,
            models: [{ name: 'Fable', utilization: 0.1, resetsAt: now + 3_600_000 }],
            at: now,
          },
        },
      }),
      'utf8',
    );

    expect(await runCommand(context, [])).toBe(0);

    const launches = readRuns(runsLog).filter((r) => r.type === 'launch');
    expect(launches).toHaveLength(1);
    // Stayed put: the expired number is not a reason to leave an account.
    expect(launches[0]?.marker).toBe('pinned');
    // And no --model at all: nothing changed, so nothing is imposed.
    expect(launches[0]?.args ?? []).not.toContain('--model');
  });

  it('imposes NO model when the session has not pinned one', async () => {
    // With nothing pinned, Claude picks its own default and ccx cannot read it.
    // Forcing the first preference would silently move everyone onto Fable, so
    // rotation falls back to plain account capacity and adds no --model.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-model-unpinned-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_IDLE_MS = '600';
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;

    const context = makeContext(home);
    await loginAccount(context, home, 'pinned');
    // Somewhere a wrong rotation could go, so "no model imposed" is not the
    // only thing this proves.
    await loginAccount(context, home, 'spare');
    setActive('pinned', context.ctx);
    // Deliberately no settings.json model pin and no --model argument.
    const now = Date.now();
    writeFileSync(
      path.join(home, 'usage-snapshot.json'),
      JSON.stringify({
        accounts: {
          pinned: {
            fiveHour: 0.1,
            sevenDay: 0.2,
            fiveHourReset: null,
            sevenDayReset: null,
            // Spent, and genuinely so, but nothing is running on Fable here.
            models: [{ name: 'Fable', utilization: 1, resetsAt: null }],
            at: now,
          },
          spare: {
            fiveHour: 0,
            sevenDay: 0,
            fiveHourReset: null,
            sevenDayReset: null,
            models: [{ name: 'Fable', utilization: 0.1, resetsAt: now + 3_600_000 }],
            at: now,
          },
        },
      }),
      'utf8',
    );

    expect(await runCommand(context, [])).toBe(0);

    const launches = readRuns(runsLog).filter((r) => r.type === 'launch');
    expect(launches).toHaveLength(1);
    // With no model in play, a spent Fable number is not a reason to move.
    expect(launches[0]?.marker).toBe('pinned');
    expect(launches[0]?.args ?? []).not.toContain('--model');
  });

  it('does not touch the model when the one in use still has room', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-model-keep-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_IDLE_MS = '600';
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;

    const context = makeContext(home);
    await loginAccount(context, home, 'only');
    setActive('only', context.ctx);
    mkdirSync(path.join(home, 'session'), { recursive: true });
    writeFileSync(
      path.join(home, 'session', 'settings.json'),
      JSON.stringify({ model: 'claude-fable-5[1m]' }),
      'utf8',
    );
    const now = Date.now();
    writeFileSync(
      path.join(home, 'usage-snapshot.json'),
      JSON.stringify({
        accounts: {
          only: {
            fiveHour: 0,
            sevenDay: 0,
            fiveHourReset: null,
            sevenDayReset: null,
            models: [{ name: 'Fable', utilization: 0.3, resetsAt: null }],
            at: now,
          },
        },
      }),
      'utf8',
    );

    expect(await runCommand(context, [])).toBe(0);
    const launches = readRuns(runsLog).filter((r) => r.type === 'launch');
    // No --model forced on: the session keeps whatever it was already using.
    expect(launches[0]?.args ?? []).not.toContain('--model');
  });
});
describe('claude subcommands through the shim', () => {
  afterEach(() => {
    delete process.env.FAKE_CLAUDE_IDLE_MS;
    delete process.env.FAKE_CLAUDE_RUNS_LOG;
  });

  it('passes them straight through, without the session flags that break them', async () => {
    // With the transparent shim installed, `claude mcp list` becomes
    // `ccx run -- mcp list`. Routing that into the session path added
    // --session-id (so a swap can resume the conversation) and the subcommand
    // rejected it outright:
    //
    //     error: unknown option '--session-id'
    //
    // Installing ccx therefore broke `claude update`, `claude mcp`, and the
    // rest, which is the opposite of transparent.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-subcmd-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;

    const context = makeContext(home);
    await loginAccount(context, home, 'only');
    setActive('only', context.ctx);

    expect(await runCommand(context, ['mcp', 'list'])).toBe(0);

    const launches = readRuns(runsLog).filter((r) => r.type === 'launch');
    expect(launches).toHaveLength(1);
    expect(launches[0]?.args).toEqual(['mcp', 'list']);
  });

  it('still gives an ordinary session the full hot-swap treatment', async () => {
    // The guard against over-matching: a session must NOT fall into the
    // passthrough, or it silently loses account rotation.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-subcmd-session-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;

    const context = makeContext(home);
    await loginAccount(context, home, 'only');
    setActive('only', context.ctx);

    await runCommand(context, ['update the readme please']);

    const launches = readRuns(runsLog).filter((r) => r.type === 'launch');
    expect(launches.length).toBeGreaterThanOrEqual(1);
    // The session path is the one that adds a session id.
    expect(launches[0]?.args).toContain('--session-id');
  });
});

describe('a subcommand needs no ccx account', () => {
  afterEach(() => {
    delete process.env.FAKE_CLAUDE_RUNS_LOG;
  });

  it('runs on an installation with nothing registered yet', async () => {
    // Routing this after the account check meant `claude update` answered "no
    // accounts registered" on a fresh install, which is exactly when somebody
    // is most likely to run it.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-subcmd-noacct-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;

    const context = makeContext(home);
    expect(await runCommand(context, ['update'])).toBe(0);

    const launches = readRuns(runsLog).filter((r) => r.type === 'launch');
    expect(launches).toHaveLength(1);
    expect(launches[0]?.args).toEqual(['update']);
  });
});
