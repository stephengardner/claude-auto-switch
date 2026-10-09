import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:os';
import { invokerArgs, type ClaudeInvoker } from '../invoker.js';
import { createRefusalFollower, type Refusal } from '../session/transcript.js';
import { matchesCapText, resetAtIn } from './cap-detect.js';
import { scrubHostEnv } from './child-env.js';
import { conversationIdIn, wantsExistingConversation } from './conversation.js';
import type { SessionOutcome } from './hot-swap.js';

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
  /** As runPtySession's: an account the operator asked this session to move to. */
  switchWatch?: () => string | null;
  /** As runPtySession's: kept running for as long as Claude is (leases, logins). */
  onTick?: () => void;
  /** Resolves true only when the account is really out (asked of the account). */
  verifyCap?: (renderedText: string) => Promise<boolean>;
  ignoreLimits?: boolean;
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
/** Signals that end a worker. Claude, and everything it started, is stopped on the way out. */
const ENDING_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

type Hit = { reason?: string; resetAt?: number };

/** The exit code a shell would report: the code, or 128 + the signal that ended it. */
function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (typeof code === 'number') return code;
  const number = signal ? constants.signals[signal] : undefined;
  return number !== undefined ? 128 + number : 1;
}

/**
 * Every process under `root` in a `ps -A -o pid=,ppid=` listing, children
 * before grandchildren.
 */
export function descendantsIn(table: string, root: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of table.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || !Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const queue = [root];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const pid of children.get(next) ?? []) {
      if (pid === root || found.includes(pid)) continue;
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
}

function descendantsOf(root: number): number[] {
  try {
    const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return descendantsIn(table, root);
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

function signalAll(pids: readonly number[], signal: NodeJS.Signals): void {
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
 * to (SIGKILL) whatever is still running KILL_GRACE_MS later.
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
  // Read before anything is signalled: once Claude exits, what it started is
  // no longer listed under it.
  const tree = [root, ...descendantsOf(root)];
  signalAll(tree, 'SIGTERM');
  const askedAt = Date.now();
  const watch = setInterval(() => {
    const running = tree.filter(isAlive);
    if (running.length === 0) {
      clearInterval(watch);
      return;
    }
    if (Date.now() - askedAt < KILL_GRACE_MS) return;
    clearInterval(watch);
    // And anything started since the first look.
    signalAll([...new Set([...running, ...(isAlive(root) ? descendantsOf(root) : [])])], 'SIGKILL');
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
  const record = createRefusalFollower(options.configDir, !wantsExistingConversation(options.args));
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
  /** The signal ending this worker, once one has. */
  let interruptedBy: NodeJS.Signals | null = null;
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

  /** Evidence of a refused turn: counted only once the account confirms it. */
  const evidence = (text: string, hit: Hit): void => {
    if (options.ignoreLimits || capped || switchTo || interruptedBy) return;
    if (verifying) {
      held = { text, hit };
      return;
    }
    const check = options.verifyCap ? options.verifyCap(text) : Promise.resolve(true);
    verifying = check
      .then((confirmed) => {
        if (confirmed && !switchTo && !interruptedBy) {
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
    if (options.ignoreLimits || capped || switchTo || interruptedBy) return;
    const seen = record.poll(conversation);
    recordReadable = recordReadable || seen.readable;
    for (const refusal of seen.refusals) {
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
    if (interruptedBy) return;
    if (!capped && !switchTo && options.switchWatch) {
      const target = options.switchWatch();
      if (target) {
        switchTo = target;
        stop();
        return;
      }
    }
    checkRecord();
  }, options.pollMs ?? 400);

  // Whoever started the worker can end it (an orchestrator giving up, Ctrl+C
  // in a terminal), and ending it must end Claude too, not leave it working on
  // unwatched.
  const onSignal = (signal: NodeJS.Signals): void => {
    interruptedBy = interruptedBy ?? signal;
    stop();
  };
  for (const signal of ENDING_SIGNALS) process.on(signal, onSignal);

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
      for (const signal of ENDING_SIGNALS) process.removeListener(signal, onSignal);
      const ranMs = Date.now() - startedAt;
      // A refusal written just before Claude exited is read now, and the
      // output stands in for the record only when there was none to read.
      checkRecord();
      if (!capped && !switchTo && !interruptedBy && !recordReadable && exitCode !== 0 && !options.ignoreLimits) {
        const hit = matchesCapText(tail);
        if (hit) evidence(tail, { reason: hit.reason, ...(hit.resetAt !== undefined ? { resetAt: hit.resetAt } : {}) });
      }
      // The account's answer, while one is still coming, but not for ever.
      const deadline = Date.now() + VERIFY_WAIT_MS;
      while (verifying !== null && Date.now() < deadline) await within(verifying, deadline - Date.now());
      if (interruptedBy) {
        resolve({ kind: 'ok', exitCode: exitCodeOf(null, interruptedBy), ranMs });
        return;
      }
      if (switchTo) {
        resolve({ kind: 'switch', exitCode: 0, switchTo, ranMs });
        return;
      }
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
