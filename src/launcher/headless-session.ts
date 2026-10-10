import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { invokerArgs, type ClaudeInvoker } from '../invoker.js';
import { createRefusalFollower, type Refusal } from '../session/transcript.js';
import { gateRefusals, type RefusalGate } from '../session/refusal-gate.js';
import { matchesCapText, resetAtIn } from './cap-detect.js';
import { scrubHostEnv } from './child-env.js';
import { conversationIdIn, wantsExistingConversation } from './conversation.js';
import type { SessionOutcome } from './hot-swap.js';
import type { RestartBlocker } from './pty-session.js';
import { exitCodeForSignal, type Interruption } from './interruption.js';

/**
 * One headless run of Claude (`claude -p`) for a worker: the counterpart of
 * runPtySession, with the same outcome, so the swap loop drives both alike.
 *
 * No terminal: Claude's standard output and error are handed to the caller
 * as they arrive, and nothing else is written to either. Whether a turn was
 * refused is read from the conversation's own record, exactly as in a
 * terminal session; text in the output only stands in for it when there is no
 * record to read, and either way the account is asked before anything counts.
 */
export interface HeadlessSessionOptions {
  claude: ClaudeInvoker;
  args: string[];
  /** CLAUDE_CONFIG_DIR for the run: the session folder, the same across moves. */
  configDir: string;
  env?: Record<string, string>;
  /** Where Claude works; the caller's own folder when absent. */
  cwd?: string;
  /** Written to Claude's standard input and then closed: a brief too long for a command line. */
  stdin?: string;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  /**
   * As runPtySession's: an account the operator asked this session to move to.
   * A print-mode run is never idle until it is done, so a switch that would
   * end it is never made while it runs.
   */
  switchWatch?: (restartBlocker: () => RestartBlocker | null) => string | null;
  /** As runPtySession's: kept running for as long as Claude is (leases, logins). */
  onTick?: () => void;
  /** Resolves true only when the account is really out (asked of the account). */
  verifyCap?: (renderedText: string) => Promise<boolean>;
  ignoreLimits?: boolean;
  /** As runPtySession's: which refused turns are held back or passed over. */
  limitGate?: RefusalGate;
  /** Ending the worker: an end stops this run, and one that came first means no run starts. */
  interruption?: Interruption;
  /** How often the record and the hooks are checked, in ms. */
  pollMs?: number;
}

/** What is kept of the output for recognising messages: its last few thousand characters. */
const TAIL = 6000;
/** How long Claude, and whatever it started, have to end when asked, before they are made to. */
const KILL_GRACE_MS = 3000;
/** The longest the outcome waits for the account's answer about a refusal; the probe itself gives up sooner. */
const VERIFY_WAIT_MS = 12_000;
/** How long Claude's output may stay open after it exits, held by something it started, before the run is over anyway. */
const CLOSE_WAIT_MS = 5000;

type Hit = { reason?: string; resetAt?: number };

/** The exit code a shell would report: the code, or 128 + the signal that ended it. */
function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  return code ?? (signal ? exitCodeForSignal(signal) : 1);
}

/** One line of `ps -A -o pid=,ppid=,lstart=`: a process, its parent, and when it started. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  /** As ps prints it. With the pid it names one process: a pid freed and used again starts later. */
  started: string;
}

export function processRows(table: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of table.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), started: match[3] ?? '' });
  }
  return rows;
}

/** Every process under `root` in `rows`, children before grandchildren. */
export function descendantsIn(rows: readonly ProcessRow[], root: number): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const found: ProcessRow[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const row of children.get(next) ?? []) {
      if (seen.has(row.pid)) continue;
      seen.add(row.pid);
      found.push(row);
      queue.push(row.pid);
    }
  }
  return found;
}

function readProcesses(): ProcessRow[] {
  try {
    return processRows(
      execFileSync('ps', ['-A', '-o', 'pid=,ppid=,lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    );
  } catch {
    return [];
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalAll(pids: Iterable<number>, signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * End Claude and everything it started: a test run or a dev server Claude
 * started must not go on running, or editing the same folder, after it. On
 * Windows the whole tree at once; elsewhere asked first (SIGTERM), then made
 * to (SIGKILL) whatever is still running KILL_GRACE_MS later. Only what is
 * provably the same process is made to: the same pid started at the same
 * moment, or something still running under Claude.
 */
function endTree(child: ChildProcess): void {
  const root = child.pid;
  if (root === undefined) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(root), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    } catch {
      /* fall through to an ordinary kill */
    }
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    return;
  }
  const rootDone = (): boolean => child.exitCode !== null || child.signalCode !== null;
  // Read before anything is signalled: once Claude exits, what it started is
  // no longer listed under it.
  const descendants = descendantsIn(readProcesses(), root);
  // Claude itself through its own handle, which never signals a pid that has
  // since been given to another process.
  child.kill('SIGTERM');
  signalAll(
    descendants.map((p) => p.pid),
    'SIGTERM',
  );
  const askedAt = Date.now();
  const watch = setInterval(() => {
    if (rootDone() && !descendants.some((p) => isAlive(p.pid))) {
      clearInterval(watch);
      return;
    }
    if (Date.now() - askedAt < KILL_GRACE_MS) return;
    clearInterval(watch);
    const now = readProcesses();
    const startedAt = new Map(now.map((p) => [p.pid, p.started]));
    const same = descendants.filter((p) => startedAt.get(p.pid) === p.started);
    const since = rootDone() ? [] : descendantsIn(now, root);
    if (!rootDone()) child.kill('SIGKILL');
    signalAll(new Set([...same, ...since].map((p) => p.pid)), 'SIGKILL');
  }, 250);
}

/** Wait for `promise` to settle, or for `ms` to pass, whichever is first. */
function within(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}

export function runHeadlessSession(options: HeadlessSessionOptions): Promise<SessionOutcome> {
  const startedAt = Date.now();
  // Ended before it began: nothing is started.
  const already = options.interruption?.exitCode ?? null;
  if (already !== null) return Promise.resolve({ kind: 'ok', exitCode: already, ranMs: 0 });

  const argv = invokerArgs(options.claude, options.args);
  const child = spawn(options.claude.bin, argv, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    // A new, top-level Claude on the account ccx installed. Nothing comes
    // from a Claude this worker was started by: above all not its login
    // token, which Claude would read before the session's own credential and
    // so run on the orchestrator's account while ccx believed otherwise.
    env: { ...scrubHostEnv(process.env), CLAUDE_CONFIG_DIR: options.configDir, ...(options.env ?? {}) },
    stdio: [options.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (options.stdin !== undefined) {
    child.stdin?.on('error', () => {
      /* Claude gone before reading it: its exit says why */
    });
    child.stdin?.end(options.stdin);
  }

  const conversation = conversationIdIn(options.args);
  const resumedId = wantsExistingConversation(options.args) ? conversation : null;
  const record = gateRefusals(
    createRefusalFollower(options.configDir, !wantsExistingConversation(options.args)),
    options.limitGate,
  );
  let recordReadable = false;
  let tail = '';
  const keep = (chunk: string): void => {
    tail = (tail + chunk).slice(-TAIL);
  };
  // Decoded as a stream: a character split between two reads arrives whole,
  // where decoding each read alone turns both halves into replacement marks.
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (text: string) => {
    keep(text);
    options.onStdout(text);
  });
  child.stderr?.on('data', (text: string) => {
    keep(text);
    options.onStderr(text);
  });

  /** A cap the account confirmed; null until one is. */
  let capped: Hit | null = null;
  let switchTo: string | null = null;
  /** The exit code the worker is being ended with, once it is. */
  let interruptedBy: number | null = null;
  /** The confirmation in flight; the outcome waits for it, within VERIFY_WAIT_MS. */
  let verifying: Promise<void> | null = null;
  /** A refusal seen while another was being confirmed: asked about next, not dropped. */
  let held: { text: string; hit: Hit } | null = null;
  let exited = false;
  let stopped = false;

  const stop = (): void => {
    if (exited || stopped) return;
    stopped = true;
    endTree(child);
  };

  /**
   * Evidence of a refused turn: counted only once the account confirms it. No
   * new question is asked once the worker is being ended; one already asked
   * still counts when it comes back.
   */
  const evidence = (text: string, hit: Hit): void => {
    if (options.ignoreLimits || capped || switchTo || interruptedBy !== null) return;
    if (verifying) {
      held = { text, hit };
      return;
    }
    const check = options.verifyCap ? options.verifyCap(text) : Promise.resolve(true);
    verifying = check
      .then((confirmed) => {
        if (confirmed && !switchTo) {
          capped = hit;
          stop();
        }
      })
      .catch(() => {
        /* not confirmed */
      })
      .finally(() => {
        verifying = null;
        const next = held;
        held = null;
        if (next) evidence(next.text, next.hit);
      });
  };

  const hitOf = (refusal: Refusal): { text: string; hit: Hit } => {
    const resetAt = resetAtIn(refusal.text);
    return {
      text: refusal.text,
      hit: { reason: refusal.apiError ?? refusal.error, ...(resetAt !== undefined ? { resetAt } : {}) },
    };
  };

  const checkRecord = (): void => {
    if (options.ignoreLimits || capped || switchTo || interruptedBy !== null) return;
    const seen = record.poll(conversation);
    recordReadable = recordReadable || seen.readable;
    for (const refusal of seen.refusals) {
      // A subagent's refusal ends nothing here: a headless run cannot be moved
      // under a live Claude, and its main thread meets the same limit at its
      // own next request, which is the refusal the run ends on.
      if (refusal.sidechain) continue;
      const { text, hit } = hitOf(refusal);
      evidence(text, hit);
    }
  };

  const timer = setInterval(() => {
    try {
      options.onTick?.();
    } catch {
      /* a hook failing must not end the run */
    }
    if (interruptedBy !== null) return;
    if (!capped && !switchTo && options.switchWatch) {
      const target = options.switchWatch(() => ({
        kind: 'headless',
        why: 'it runs headless, and is idle only once its task is done',
      }));
      if (target) {
        switchTo = target;
        stop();
        return;
      }
    }
    checkRecord();
  }, options.pollMs ?? 400);

  // Ending the worker ends Claude, and what Claude started, too.
  const unsubscribe =
    options.interruption?.onEnd(() => {
      // Claude already done: the end changes nothing about this run.
      if (child.exitCode !== null || child.signalCode !== null) return;
      interruptedBy = options.interruption?.exitCode ?? 1;
      stop();
    }) ?? null;

  return new Promise<SessionOutcome>((resolve) => {
    let finished = false;
    let closeWait: NodeJS.Timeout | null = null;
    const finish = async (exitCode: number): Promise<void> => {
      // 'error' and 'close' can both arrive for one failed start, and the
      // fallback after 'exit' can race 'close'.
      if (finished) return;
      finished = true;
      exited = true;
      clearInterval(timer);
      if (closeWait) clearTimeout(closeWait);
      unsubscribe?.();
      const ranMs = Date.now() - startedAt;
      // A refusal written just before Claude exited is read now, and the
      // output stands in for the record only when there was none to read.
      checkRecord();
      if (
        !capped &&
        !switchTo &&
        interruptedBy === null &&
        !recordReadable &&
        exitCode !== 0 &&
        !options.ignoreLimits &&
        !options.limitGate?.held()
      ) {
        const hit = matchesCapText(tail);
        if (hit) evidence(tail, { reason: hit.reason, ...(hit.resetAt !== undefined ? { resetAt: hit.resetAt } : {}) });
      }
      // The account's answer, while one is still coming, but not for ever, and
      // only briefly when the worker is being ended.
      const deadline = Date.now() + (interruptedBy !== null ? KILL_GRACE_MS : VERIFY_WAIT_MS);
      while (verifying !== null && Date.now() < deadline) await within(verifying, deadline - Date.now());
      if (switchTo && interruptedBy === null) {
        resolve({ kind: 'switch', exitCode: 0, switchTo, ranMs });
        return;
      }
      // A confirmed cap is reported even when the worker is being ended, so the
      // ledger learns the limit this run paid to confirm. The loop then ends
      // at its next step, since the next launch sees the signal and starts
      // nothing.
      if (capped) {
        resolve({
          kind: 'capped',
          exitCode,
          ranMs,
          ...(capped.reason !== undefined ? { reason: capped.reason } : {}),
          ...(capped.resetAt !== undefined ? { resetAt: capped.resetAt } : {}),
        });
        return;
      }
      if (interruptedBy !== null) {
        resolve({ kind: 'ok', exitCode: interruptedBy, ranMs });
        return;
      }
      // A resume of a conversation that was never written: the swap loop's
      // caller starts a fresh one instead.
      if (resumedId !== null && tail.includes(`No conversation found with session ID: ${resumedId}`)) {
        resolve({ kind: 'no-conversation', exitCode, ranMs });
        return;
      }
      resolve({ kind: 'ok', exitCode, ranMs });
    };
    child.on('close', (code, signal) => {
      void finish(exitCodeOf(code, signal));
    });
    // 'close' waits for Claude's output to close, and something Claude started
    // can hold it open after Claude itself has gone.
    child.on('exit', (code, signal) => {
      if (finished) return;
      closeWait = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        void finish(exitCodeOf(code, signal));
      }, CLOSE_WAIT_MS);
    });
    child.on('error', (err) => {
      // A kill or a write that failed while Claude runs on: its exit says how
      // the run ended. Only a start that failed has no process to wait for.
      if (child.pid !== undefined) return;
      options.onStderr(`ccx: could not start claude: ${err.message}\n`);
      void finish(127);
    });
  });
}
