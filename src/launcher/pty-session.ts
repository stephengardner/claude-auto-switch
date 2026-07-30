import { execFileSync } from 'node:child_process';
import { spawn, type IPty } from 'node-pty';
import { matchesCapText } from './cap-detect.js';
import { invokerArgs, type ClaudeInvoker } from '../invoker.js';
import { writeSecretFile } from '../util/secret-file.js';
import { normalizeExitCode } from './exit-code.js';
import { openTerminalInput, type TerminalInput } from './terminal-input.js';
import type { SessionOutcome } from './hot-swap.js';

export interface PtySessionOptions {
  claude: ClaudeInvoker;
  args: string[];
  /** CLAUDE_CONFIG_DIR for the session (kept constant across swaps so --continue works). */
  configDir: string;
  /** Extra env for this launch (e.g. CLAUDE_CODE_OAUTH_TOKEN for the active account). */
  env?: Record<string, string>;
  /** If set, write the session's raw output here for debugging cap detection. */
  debugLog?: string;
  /**
   * Polled periodically; return an account name when the operator has picked a
   * different account mid-session, and the child is ended so the swap loop
   * relaunches --continue on it. Return null to keep running.
   */
  switchWatch?: () => string | null;
  /**
   * Called when cap-looking text renders, with that text; resolves true ONLY if
   * the account is actually limited (verified against the API). Rendered text
   * alone is untrustworthy: --continue and the resume picker REPLAY history,
   * including old cap messages, and code on screen can mention rate limits.
   * When absent, a text match is trusted as-is (legacy behavior).
   */
  verifyCap?: (renderedText: string) => Promise<boolean>;
  /**
   * Do not watch for usage limits during this run. Used for the deliberate
   * "run anyway" case, where the limit is already known and the operator needs
   * the session to start so they can switch models.
   */
  ignoreLimits?: boolean;
  /**
   * The run's terminal input. Sessions borrow the operator's keyboard from this
   * owner rather than taking the terminal into raw mode themselves, so a swap
   * never toggles global terminal state mid-teardown.
   */
  input?: TerminalInput;
}

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * Run a claude session inside a pseudo-terminal, relaying it transparently to
 * the operator's terminal (so the TUI still sees a real terminal) while watching
 * the output stream for the rate-limit signal. Resolves 'capped' (and ends the
 * child) when the cap appears, or 'ok' on a normal exit.
 */
export function runPtySession(options: PtySessionOptions): Promise<SessionOutcome> {
  return new Promise((resolve) => {
    const child: IPty = spawn(options.claude.bin, invokerArgs(options.claude, options.args), {
      name: process.env.TERM ?? 'xterm-256color',
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      cwd: process.cwd(),
      env: cleanEnv({ CLAUDE_CONFIG_DIR: options.configDir, ...(options.env ?? {}) }),
    });

    let capped: { reason?: string; resetAt?: number } | null = null;
    let noConversation = false;
    let window = '';
    let captured = '';
    let switching: string | null = null;
    let exited = false;
    let verifying = false;
    let suppressUntil = 0;
    let lastHit: { reason?: string; resetAt?: number } | null = null;
    let pendingVerify: Promise<boolean> | null = null;
    let finalized = false;
    // The "No conversation found to continue" error only matters on a --continue
    // launch, and the real one prints in the FIRST flush of output. Watching any
    // longer would let a REPLAYED conversation that merely contains that phrase
    // kill the session (the same trap as replayed cap text).
    const watchNoConversation =
      options.args.includes('--continue') || options.args.includes('-c');
    let totalOutput = 0;

    let weKilled = false;
    /**
     * End the child. On Windows we terminate the process tree directly instead
     * of calling node-pty's kill(): that path spawns a console-enumeration
     * helper and tears the pseudo-terminal down asynchronously, which races the
     * next session's spawn during an account swap and can corrupt the host
     * process. Killing the process makes node-pty observe an ordinary exit.
     */
    const safeKill = (): void => {
      if (exited) return;
      weKilled = true;
      if (process.platform === 'win32' && child.pid) {
        try {
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
          return;
        } catch {
          /* fall through to node-pty's own kill */
        }
      }
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };

    // The operator can pick a different account mid-session (dashboard Enter /
    // `ccx use`); poll for that and end the child so the swap loop relaunches
    // --continue on the chosen account, in place.
    const switchPoll = options.switchWatch
      ? setInterval(() => {
          if (capped || switching || noConversation) return;
          const target = options.switchWatch!();
          if (target) {
            switching = target;
            setTimeout(safeKill, 80);
          }
        }, 400)
      : null;

    const dataSub = child.onData((data) => {
      process.stdout.write(data);
      if (options.debugLog) captured += data;
      if (capped || switching) return;
      totalOutput += data.length;
      window = (window + data).slice(-4000);
      // A --continue with nothing to resume: signal a fresh relaunch is needed.
      if (
        watchNoConversation &&
        totalOutput <= 6000 &&
        /No conversation found to continue/i.test(window)
      ) {
        noConversation = true;
        setTimeout(() => safeKill(), 100);
        return;
      }
      // Cap-looking text is a TRIGGER, never a verdict. --continue and the
      // resume picker replay history (old cap messages included), and code on
      // screen can mention rate limits; acting on text alone falsely capped
      // every account in turn. Verify against the API and only act when the
      // account is confirmed limited. Refuted matches back off briefly so a
      // replay cannot spam probes.
      if (options.ignoreLimits) return;
      if (verifying || Date.now() < suppressUntil) return;
      const hit = matchesCapText(window);
      if (!hit) return;
      const snapshot = window;
      window = '';
      if (!options.verifyCap) {
        capped = { reason: hit.reason, resetAt: hit.resetAt };
        setTimeout(safeKill, 150);
        return;
      }
      verifying = true;
      lastHit = { reason: hit.reason, resetAt: hit.resetAt };
      // Kept as a handle: if the child exits while this is in flight (claude
      // EXITS ITSELF on a session limit), the exit path awaits the verdict
      // instead of concluding "normal exit" and dropping the session.
      pendingVerify = options
        .verifyCap(snapshot)
        .then((confirmed) => {
          verifying = false;
          if (confirmed) {
            if (!capped && !switching) {
              capped = { reason: hit.reason, resetAt: hit.resetAt };
              if (!exited) setTimeout(safeKill, 150);
            }
          } else {
            suppressUntil = Date.now() + 20_000;
          }
          return confirmed;
        })
        .catch(() => {
          verifying = false;
          suppressUntil = Date.now() + 20_000;
          return false;
        });
    });

    // Borrow the keyboard from the run's owner (or claim it just for this
    // session when running standalone, e.g. in tests).
    const ownsInput = options.input === undefined;
    const input = options.input ?? openTerminalInput();
    const detachInput = input.attach((text) => child.write(text));

    const onResize = (): void => {
      child.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
    };
    process.stdout.on('resize', onResize);

    const exitSub = child.onExit((report) => {
      // Normalized here, at the only place a pty exit enters ccx: on Windows this
      // report can arrive with no code and no signal at all, and passing that
      // through told the shell "undefined", which reads as success.
      const exitCode = normalizeExitCode(report);
      exited = true;
      exitSub.dispose();
      if (switchPoll) clearInterval(switchPoll);
      // Stop routing keystrokes here, but leave the terminal's MODE alone: the
      // run's owner holds it across sessions so a swap never toggles it.
      detachInput();
      if (ownsInput) input.close();
      process.stdout.off('resize', onResize);

      const finalize = (): void => {
        if (finalized) return;
        finalized = true;
        dataSub.dispose();
        // Nothing is killed here. The child has already exited; calling kill()
        // on a dead pseudo-terminal re-enters node-pty's async Windows teardown
        // for no benefit. Input/handle release is owned by the run (see
        // terminal-input), which is what keeps the process from hanging.
        void weKilled;
        if (options.debugLog) {
          // The debug log is a full transcript of a live session; write it
          // owner-only. CAS_DEBUG is opt-in and documented as sensitive.
          try {
            writeSecretFile(options.debugLog, captured);
          } catch {
            /* best effort */
          }
        }
        resolve(
          switching
            ? { kind: 'switch', exitCode, switchTo: switching }
            : capped
              ? { kind: 'capped', exitCode, reason: capped.reason, resetAt: capped.resetAt }
              : noConversation
                ? { kind: 'no-conversation', exitCode }
                : { kind: 'ok', exitCode },
        );
      };

      // Claude EXITS ITSELF on a session limit, and ConPTY can flush the very
      // output containing that limit message AFTER the exit event. So: give the
      // trailing flush a moment, then settle any in-flight (or newly-triggered)
      // verification BEFORE deciding this was a normal exit. Without this, a
      // real cap raced the async verdict and the whole session ended instead of
      // rotating (the "my session completely terminated" bug).
      setTimeout(() => {
        if (capped || switching || noConversation) return finalize();
        const timeboxed = (p: Promise<boolean>): Promise<boolean> =>
          Promise.race([p, new Promise<boolean>((r) => setTimeout(() => r(false), 12_000))]);
        if (pendingVerify) {
          void timeboxed(pendingVerify).then((confirmed) => {
            if (confirmed && !capped) capped = lastHit ?? {};
            finalize();
          });
          return;
        }
        const hit = matchesCapText(window);
        if (hit && options.verifyCap) {
          // Deliberately ignores the refute-backoff: a REAL cap can land inside
          // the 20s window right after a refuted replay, and the child is gone
          // so one probe here is the only chance to catch it.
          void timeboxed(options.verifyCap(window).catch(() => false)).then((confirmed) => {
            if (confirmed) capped = { reason: hit.reason, resetAt: hit.resetAt };
            finalize();
          });
          return;
        }
        if (hit && !options.verifyCap) capped = { reason: hit.reason, resetAt: hit.resetAt };
        finalize();
      }, 250);
    });
  });
}
