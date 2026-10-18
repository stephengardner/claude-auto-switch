import { afterEach, describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { addAccount } from '../../src/accounts/registry.js';
import { renameAccount } from '../../src/accounts/rename.js';
import { capCommand } from '../../src/commands/cap.js';
import { editorLaunch } from '../../src/commands/editor-launch.js';
import { runCommand } from '../../src/commands/run.js';
import { workerCommand } from '../../src/commands/worker.js';
import { loadConfig } from '../../src/config/config.js';
import { readEvents } from '../../src/events/log.js';
import { acquireOwnedLock } from '../../src/claude/locks.js';
import { processIsAlive } from '../../src/session/lease.js';
import { setActive } from '../../src/state/active.js';
import type { CliContext } from '../../src/context.js';
import type { LimitProbeResult, LimitVerdict } from '../../src/usage/limit-probe.js';

/**
 * Two ccx processes changing the limits ledger at once. Every change reads the
 * whole file and writes it back, so one that reads while another's change is in
 * progress, and writes after it, erases that change: a limit another session
 * recorded is gone, and the account goes back into rotation while it is out.
 *
 * The other process here takes the ledger's lock, reads the file, and writes it
 * back only once the writer under test has found the lock taken, as any change
 * does in the moment between its read and its write. Each writer under test
 * must wait for it and build on what it wrote. Children run through tsx (a
 * devDependency), so no build is needed.
 */

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const TSX = path.join(REPO, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));
const moduleAt = (...parts: string[]): string => JSON.stringify(path.join(REPO, 'src', ...parts).split(path.sep).join('/'));
const HOUR = 3_600_000;

interface Cap {
  account: string;
  capUntil: number | null;
  reason: string;
  at: number;
}

const capsIn = (home: string): Cap[] => {
  const file = path.join(home, 'ledger.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { caps: Cap[] }).caps : [];
};
const accountsIn = (home: string): string[] => capsIn(home).map((cap) => cap.account).sort();
const unlockedWrites = (home: string) => readEvents(home, 100).filter((e) => e.kind === 'ledger-unlocked');

interface OtherWriter {
  /** Settles once it is running and waiting to be told to go. */
  ready: Promise<void>;
  /**
   * Tell it to go, and settle once it holds the lock and has read the ledger.
   * From then it lets go as soon as ccx, in this process, finds the lock taken.
   */
  go: () => Promise<void>;
  /** Whether ccx found the lock taken while this writer held it. */
  waitedFor: () => boolean;
  exited: Promise<{ code: number | null; stderr: string }>;
}

/**
 * ccx asks whether the process a held lock names is still running each time
 * it finds the lock taken (process.kill with signal 0), and only then: it is
 * how this process is seen waiting. `then` is called on the first such ask
 * about `holder`. Undone by `vi.restoreAllMocks()`.
 */
function onWaitFor(holder: number, then: () => void): void {
  const kill = process.kill.bind(process);
  let seen = false;
  vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
    if (pid === holder && signal === 0 && !seen) {
      seen = true;
      then();
    }
    return kill(pid, signal);
  });
}

/**
 * Another process recording a limit for `account`. Told to go, it takes the
 * lock and reads the ledger, then holds the lock until ccx is seen waiting for
 * it (onWaitFor), however long ccx takes to get there, and only then writes
 * and lets go. Started ahead of time and told to go from inside the step under
 * test, so its own start-up never delays that step. Never let go, it writes
 * after 30 s all the same and fails, saying so.
 */
function anotherWriter(home: string, account: string): OtherWriter {
  const script = path.join(home, `writer-${account}.ts`);
  const marker = (name: string): string => path.join(home, `writer-${account}.${name}`);
  writeFileSync(
    script,
    [
      `import { existsSync, readFileSync, writeFileSync } from 'node:fs';`,
      `import path from 'node:path';`,
      `import { acquireOwnedLock } from ${moduleAt('claude', 'locks.ts')};`,
      `import { writeJsonFile } from ${moduleAt('util', 'fs-json.ts')};`,
      `const [home, account, ready, go, read, release] = process.argv.slice(2);`,
      `const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);`,
      `writeFileSync(ready, '');`,
      `const giveUpAt = Date.now() + 60000;`,
      `while (!existsSync(go)) {`,
      `  if (Date.now() > giveUpAt) throw new Error('the other writer was never told to go');`,
      `  pause(10);`,
      `}`,
      `const file = path.join(home, 'ledger.json');`,
      `const lock = acquireOwnedLock(file + '.lock', { waitMs: 30000, staleMs: 5000 });`,
      `if (!lock.held) throw new Error('the other writer could not take the ledger lock');`,
      `const ledger = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { caps: [] };`,
      // Its own pid, which is the one the lock names.
      `writeFileSync(read, String(process.pid));`,
      `const holdUntil = Date.now() + 30000;`,
      `while (!existsSync(release) && Date.now() < holdUntil) pause(10);`,
      `ledger.caps.push({ account, capUntil: Date.now() + 3600000, reason: 'another session', at: Date.now() });`,
      `writeJsonFile(file, ledger);`,
      `lock.release();`,
      `if (!existsSync(release)) throw new Error('ccx never found the lock taken in 30 s');`,
    ].join('\n'),
    'utf8',
  );

  let stderr = '';
  let ended = false;
  let waited = false;
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const args = [script, home, account, marker('ready'), marker('go'), marker('read'), marker('release')];
    const child = spawn(TSX, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: process.platform === 'win32' });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('exit', (code) => {
      ended = true;
      resolve({ code, stderr });
    });
  });
  const reached = async (name: string): Promise<void> => {
    await vi.waitUntil(() => existsSync(marker(name)) || ended, { timeout: 30_000, interval: 10 });
    expect(existsSync(marker(name)), `the other writer ended before "${name}": ${stderr}`).toBe(true);
  };
  const ready = reached('ready');
  ready.catch(() => {}); // awaited by go(), which reports it
  return {
    ready,
    go: async () => {
      await ready;
      writeFileSync(marker('go'), '');
      await reached('read');
      onWaitFor(Number(readFileSync(marker('read'), 'utf8')), () => {
        waited = true;
        writeFileSync(marker('release'), '');
      });
    },
    waitedFor: () => waited,
    exited,
  };
}

/** Accounts signed in, through the fake claude; those named in `capped` are out on every run. */
function setup(names: string[], capped: string[] = []): { home: string; context: CliContext } {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-ledger-race-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  for (const name of names) {
    const dir = path.join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }), 'utf8');
    writeFileSync(
      path.join(dir, 'fake-scenario.json'),
      JSON.stringify({
        authStatus: { loggedIn: true, subscriptionType: 'max', email: `${name.toLowerCase()}@example.com` },
        capped: capped.includes(name),
        capMessage: 'Usage limit reached. Try again later.',
        capExitCode: 1,
      }),
      'utf8',
    );
    addAccount({ name, dir }, ctx);
  }
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
  };
  return { home, context };
}

/** Variables the worker case sets for the fake claude, put back afterwards. */
const REFUSING: Record<string, string> = {
  FAKE_CLAUDE_IDLE_MS: '4000',
  FAKE_CLAUDE_SESSION_RECORD: '1',
  FAKE_CLAUDE_TRANSCRIPT: '1',
  FAKE_CLAUDE_REFUSE_AFTER_MS: '1200',
};

describe('two processes changing the limits ledger at once', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ccx cap waits for a change already in progress, and both limits are kept', async () => {
    const { home, context } = setup(['A']);
    const other = anotherWriter(home, 'B');
    await other.go();
    // Started after the other process read, before it writes.
    expect(capCommand(context, 'A')).toBe(0);
    const { code, stderr } = await other.exited;
    expect(code, stderr).toBe(0);
    expect(other.waitedFor(), 'ccx never found the lock taken').toBe(true);

    expect(accountsIn(home)).toEqual(['A', 'B']);
    // Waited for the lock, rather than writing past it once the wait ran out.
    expect(unlockedWrites(home)).toEqual([]);
  }, 60_000);

  it('ccx cap --clear clears only its own account, and keeps the limit recorded meanwhile', async () => {
    const { home, context } = setup(['A']);
    expect(capCommand(context, 'A')).toBe(0);
    const other = anotherWriter(home, 'B');
    await other.go();
    expect(capCommand(context, 'A', { clear: true })).toBe(0);
    const { code, stderr } = await other.exited;
    expect(code, stderr).toBe(0);
    expect(other.waitedFor(), 'ccx never found the lock taken').toBe(true);

    expect(accountsIn(home)).toEqual(['B']);
    expect(unlockedWrites(home)).toEqual([]);
  }, 60_000);

  it('a rename moves the limits to the new name, and keeps the one recorded meanwhile', async () => {
    const { home, context } = setup(['old']);
    expect(capCommand(context, 'old')).toBe(0);
    const other = anotherWriter(home, 'B');
    await other.go();
    renameAccount('old', 'new', {}, context.ctx);
    const { code, stderr } = await other.exited;
    expect(code, stderr).toBe(0);
    expect(other.waitedFor(), 'ccx never found the lock taken').toBe(true);

    expect(accountsIn(home)).toEqual(['B', 'new']);
    expect(unlockedWrites(home)).toEqual([]);
  }, 60_000);

  it('a session that meets a limit records it on top of a change in progress (a worker here)', async () => {
    // The usage check confirms A is out just after the other process has read
    // the ledger. The session then ends that launch and records the limit.
    const { home, context } = setup(['A', 'B']);
    const other = anotherWriter(home, 'other');
    await other.ready;
    let checks = 0;
    context.verifyCap = async (): Promise<LimitVerdict> => {
      checks += 1;
      if (checks > 1) return 'allowed';
      await other.go();
      return 'limited';
    };
    context.isClaudeProcess = processIsAlive;
    const before = Object.fromEntries(Object.keys(REFUSING).map((name) => [name, process.env[name]]));
    Object.assign(process.env, REFUSING);
    try {
      const io = { stdout: () => {}, stderr: () => {}, signals: new EventEmitter() };
      expect(await workerCommand(context, ['hi'], {}, [], io)).toBe(0);
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    const { code, stderr } = await other.exited;
    expect(code, stderr).toBe(0);
    expect(other.waitedFor(), 'ccx never found the lock taken').toBe(true);

    expect(accountsIn(home)).toEqual(['A', 'other']);
    expect(unlockedWrites(home)).toEqual([]);
  }, 60_000);

  it('the editor launcher records a limit on top of a change in progress', async () => {
    const { home, context } = setup(['A', 'B'], ['A']);
    const other = anotherWriter(home, 'other');
    await other.ready;
    context.verifyCap = async (): Promise<LimitVerdict> => {
      await other.go();
      return 'limited';
    };
    setActive('A', context.ctx);
    expect(await editorLaunch(context, ['chat'])).toBe(1);
    const { code, stderr } = await other.exited;
    expect(code, stderr).toBe(0);
    expect(other.waitedFor(), 'ccx never found the lock taken').toBe(true);

    expect(accountsIn(home)).toEqual(['A', 'other']);
    expect(unlockedWrites(home)).toEqual([]);
  }, 60_000);

  it('a run on one account, without rotation, records a limit on top of a change in progress', async () => {
    const { home, context } = setup(['A', 'B'], ['A']);
    context.config.rotation.autoRotateHeadless = false;
    const other = anotherWriter(home, 'other');
    await other.ready;
    context.capProbe = async (): Promise<LimitProbeResult> => {
      await other.go();
      return { verdict: 'limited', fiveHour: 1, sevenDay: 0.4, fiveHourReset: Date.now() + HOUR };
    };
    setActive('A', context.ctx);
    // The run's own exit code, a limit's.
    expect(await runCommand(context, ['-p', 'hi'])).toBe(1);
    const { code, stderr } = await other.exited;
    expect(code, stderr).toBe(0);
    expect(other.waitedFor(), 'ccx never found the lock taken').toBe(true);

    expect(accountsIn(home)).toEqual(['A', 'other']);
    expect(unlockedWrites(home)).toEqual([]);
  }, 60_000);

  it('a limit still waiting for the lock when its process exits is written as it exits', async () => {
    // A session that met a limit while another process held the ledger, and
    // ended before that process let go.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-ledger-exit-'));
    const script = path.join(home, 'meets-a-limit.ts');
    const asked = path.join(home, 'asked');
    writeFileSync(
      script,
      [
        `import { writeFileSync } from 'node:fs';`,
        `import { markCapped, updateLedgerAsync } from ${moduleAt('ledger', 'ledger.ts')};`,
        `const [home, asked] = process.argv.slice(2);`,
        `const now = Date.now();`,
        `void updateLedgerAsync({ env: { CLAUDE_AUTO_SWITCH_HOME: home } }, (ledger) =>`,
        `  markCapped(ledger, { account: 'A', now, resetAt: now + 3600000, reason: 'met as it ended' }),`,
        `);`,
        `writeFileSync(asked, '');`,
      ].join('\n'),
      'utf8',
    );
    // Held as a running ccx holds it: by this process, which the child sees running.
    const holder = acquireOwnedLock(path.join(home, 'ledger.json.lock'), { waitMs: 0, staleMs: 5_000 });
    expect(holder.held).toBe(true);
    let exited: Promise<{ code: number | null; stderr: string }>;
    try {
      exited = new Promise((resolve) => {
        const child = spawn(TSX, [script, home, asked], {
          stdio: ['ignore', 'ignore', 'pipe'],
          shell: process.platform === 'win32',
        });
        let stderr = '';
        child.stderr.on('data', (d) => (stderr += String(d)));
        child.on('exit', (code) => resolve({ code, stderr }));
      });
      await vi.waitUntil(() => existsSync(asked), { timeout: 30_000, interval: 20 });
      // Its last statement, so by now it is exiting, waiting for the lock.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(accountsIn(home)).toEqual([]);
    } finally {
      holder.release();
    }
    const { code, stderr } = await exited;
    expect(code, stderr).toBe(0);
    expect(accountsIn(home)).toEqual(['A']);
    expect(unlockedWrites(home)).toEqual([]);
  }, 60_000);
});
