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
import { sessionDirFor } from '../../src/session/session-dir.js';
import { writeResumePrompt } from '../../src/session/resume-prompt.js';
import type { CliContext } from '../../src/context.js';

/**
 * An unattended session that ccx relaunches after an account swap comes back
 * idle at its prompt, and stays there until someone types. A session that ARMED
 * a resume prompt is handed it on every relaunch instead, so it carries on by
 * itself. These drive the real relaunch through a pseudo-terminal against the
 * fake claude, which records every launch's arguments.
 */

const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const PROMPT = 'Resumed by ccx after an account swap: this is a continuation, carry on.';

async function waitFor<T>(
  what: string,
  read: () => T,
  ok: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = read();
  while (Date.now() < deadline) {
    last = read();
    if (ok(last)) return last;
    await sleep(50);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${what}; last saw ${JSON.stringify(last)}`,
  );
}

interface RunEntry {
  type: 'launch' | 'reread';
  args?: string[];
  marker: string | null;
}

type Verdict = 'limited' | 'allowed' | 'unknown';

function makeContext(home: string, verifyCap?: () => Promise<Verdict>): CliContext {
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  return {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
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
  writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }), 'utf8');
}

function readRuns(runsLog: string): RunEntry[] {
  if (!existsSync(runsLog)) return [];
  return readFileSync(runsLog, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as RunEntry);
}

const launchesIn = (runsLog: string): RunEntry[] =>
  readRuns(runsLog).filter((r) => r.type === 'launch');

/** Arm the session THIS process runs, the way a session arms itself from inside. */
function arm(context: CliContext, prompt: string): void {
  const dir = sessionDirFor(process.pid, context.ctx);
  mkdirSync(dir, { recursive: true });
  const written = writeResumePrompt(dir, prompt);
  if (!written.ok) throw new Error(written.reason);
}

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
    ptyProblem = (err as Error).message;
    return false;
  }
}
const PTY_AVAILABLE = canSpawnPty();
if (!PTY_AVAILABLE) {
  console.warn(`[skipped] resume-prompt relaunch tests: no pseudo-terminal here (${ptyProblem}).`);
}

describe.skipIf(!PTY_AVAILABLE)('a resume prompt the session armed (against fake-claude)', () => {
  afterEach(() => {
    delete process.env.FAKE_CLAUDE_IDLE_MS;
    delete process.env.FAKE_CLAUDE_RUNS_LOG;
    delete process.env.FAKE_CLAUDE_EMIT_CAP;
  });

  it('rides the relaunch after a swap as the prompt, in the SAME conversation', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-resume-swap-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_IDLE_MS = '2500';
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;

    const context = makeContext(home);
    await loginAccount(context, home, 'A');
    await loginAccount(context, home, 'B');
    setActive('A', context.ctx);

    const run = runCommand(context, []);
    await waitFor(
      'the first launch',
      () => launchesIn(runsLog),
      (l) => l.length > 0,
    );
    // Armed from inside the running session, as an unattended session does.
    arm(context, PROMPT);
    writeSwitchRequest('B', Date.now(), 'restart', context.ctx);
    expect(await run).toBe(0);

    const launches = launchesIn(runsLog);
    expect(launches).toHaveLength(2);
    // The first launch carried nothing extra: arming affects relaunches only.
    expect(launches[0]?.args).not.toContain(PROMPT);
    const relaunch = launches[1]?.args ?? [];
    expect(relaunch).toContain('--resume');
    // The prompt is the LAST argument, the one positional prompt Claude takes.
    expect(relaunch[relaunch.length - 1]).toBe(PROMPT);
    // And the conversation is the same one, by id.
    const idOf = (args: string[] | undefined, flag: string): string | undefined => {
      const list = args ?? [];
      const i = list.indexOf(flag);
      return i >= 0 ? list[i + 1] : undefined;
    };
    expect(idOf(relaunch, '--resume')).toBe(idOf(launches[0]?.args, '--session-id'));

    const events = readFileSync(path.join(home, 'events.jsonl'), 'utf8');
    expect(events).toContain('relaunched with the resume prompt this session armed');
  });

  it('is RELAUNCHED on a verified cap instead of relieved in place, so the prompt is delivered', async () => {
    // Unarmed, a verified cap on a live session swaps the account in place and the
    // child keeps running (switch-in-session.test.ts proves that). But the turn the
    // limit interrupted has ended, so an unattended session would sit idle. Armed,
    // it must take the relaunch path, which is the only one that hands it a prompt.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-resume-cap-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_IDLE_MS = '2500'; // stays alive: the stay-on-screen flavor
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;
    process.env.FAKE_CLAUDE_EMIT_CAP = '1';

    let calls = 0;
    const context = makeContext(home, () => {
      calls += 1;
      return Promise.resolve(calls === 1 ? 'limited' : 'allowed');
    });
    await loginAccount(context, home, 'A');
    await loginAccount(context, home, 'B');
    setActive('A', context.ctx);
    arm(context, PROMPT); // armed before the session starts

    expect(await runCommand(context, [])).toBe(0);

    const launches = launchesIn(runsLog);
    expect(launches.length).toBeGreaterThanOrEqual(2);
    expect(launches[0]?.marker).toBe('A');
    expect(launches[1]?.marker).toBe('B');
    const relaunch = launches[1]?.args ?? [];
    expect(relaunch[relaunch.length - 1]).toBe(PROMPT);
    const events = readFileSync(path.join(home, 'events.jsonl'), 'utf8');
    expect(events).toContain('relaunching instead of relieving in place');
    // A's cap is still recorded exactly once.
    const caps = (
      JSON.parse(readFileSync(path.join(home, 'ledger.json'), 'utf8')) as {
        caps: Array<{ account: string }>;
      }
    ).caps;
    expect(caps.map((c) => c.account)).toEqual(['A']);
  });

  it('changes nothing for a session that armed nothing', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-resume-none-'));
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_IDLE_MS = '2500';
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;

    const context = makeContext(home);
    await loginAccount(context, home, 'A');
    await loginAccount(context, home, 'B');
    setActive('A', context.ctx);

    const run = runCommand(context, []);
    await waitFor(
      'the first launch',
      () => launchesIn(runsLog),
      (l) => l.length > 0,
    );
    writeSwitchRequest('B', Date.now(), 'restart', context.ctx);
    expect(await run).toBe(0);

    const relaunch = launchesIn(runsLog)[1]?.args ?? [];
    const i = relaunch.indexOf('--resume');
    expect(i).toBeGreaterThanOrEqual(0);
    // Nothing after the conversation id: exactly the relaunch ccx always made.
    expect(relaunch.length).toBe(i + 2);
  });
});
