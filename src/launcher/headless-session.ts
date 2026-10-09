import { execFileSync, spawn } from 'node:child_process';
import { invokerArgs, type ClaudeInvoker } from '../invoker.js';
import { createRefusalFollower, type Refusal } from '../session/transcript.js';
import { matchesCapText, resetAtIn } from './cap-detect.js';
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

export function runHeadlessSession(options: HeadlessSessionOptions): Promise<SessionOutcome> {
  const startedAt = Date.now();
  const argv = invokerArgs(options.claude, options.args);
  const child = spawn(options.claude.bin, argv, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: { ...process.env, CLAUDE_CONFIG_DIR: options.configDir, ...(options.env ?? {}) },
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
  child.stdout?.on('data', (data: Buffer) => {
    const text = data.toString('utf8');
    keep(text);
    options.onStdout(text);
  });
  child.stderr?.on('data', (data: Buffer) => {
    const text = data.toString('utf8');
    keep(text);
    options.onStderr(text);
  });

  /** A cap the account confirmed; null until one is. */
  let capped: { reason?: string; resetAt?: number } | null = null;
  let switchTo: string | null = null;
  /** The confirmation in flight, awaited before the outcome is given. */
  let verifying: Promise<void> | null = null;
  let exited = false;

  const stop = (): void => {
    if (exited || child.pid === undefined) return;
    if (process.platform === 'win32') {
      // The whole tree: a tool Claude started must not outlive it.
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        return;
      } catch {
        /* fall through to an ordinary kill */
      }
    }
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };

  /** Evidence of a refused turn: counted only once the account confirms it. */
  const evidence = (text: string, hit: { reason?: string; resetAt?: number }): void => {
    if (options.ignoreLimits || capped || switchTo || verifying) return;
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
      });
  };

  const hitOf = (refusal: Refusal): { text: string; hit: { reason?: string; resetAt?: number } } => {
    const resetAt = resetAtIn(refusal.text);
    return {
      text: refusal.text,
      hit: { reason: refusal.apiError ?? refusal.error, ...(resetAt !== undefined ? { resetAt } : {}) },
    };
  };

  const checkRecord = (): void => {
    if (options.ignoreLimits || capped || switchTo) return;
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

  return new Promise<SessionOutcome>((resolve) => {
    let finished = false;
    const finish = async (code: number | null): Promise<void> => {
      // 'error' and 'close' can both arrive for one failed start.
      if (finished) return;
      finished = true;
      exited = true;
      clearInterval(timer);
      const exitCode = code ?? 1;
      const ranMs = Date.now() - startedAt;
      // A refusal written just before Claude exited is read now, and the
      // output stands in for the record only when there was none to read.
      checkRecord();
      if (!capped && !switchTo && !verifying && !recordReadable && exitCode !== 0 && !options.ignoreLimits) {
        const hit = matchesCapText(tail);
        if (hit) evidence(tail, { reason: hit.reason, ...(hit.resetAt !== undefined ? { resetAt: hit.resetAt } : {}) });
      }
      while (verifying) await verifying;
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
    child.on('close', (code) => {
      void finish(code);
    });
    child.on('error', (err) => {
      options.onStderr(`ccx: could not start claude: ${err.message}\n`);
      void finish(127);
    });
  });
}
