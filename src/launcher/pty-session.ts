import { spawn, type IPty } from 'node-pty';
import { matchesCapText } from './cap-detect.js';
import { invokerArgs, type ClaudeInvoker } from '../invoker.js';
import { writeSecretFile } from '../util/secret-file.js';
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
    // The "No conversation found to continue" error only matters on a --continue
    // launch, and the real one prints in the FIRST flush of output. Watching any
    // longer would let a REPLAYED conversation that merely contains that phrase
    // kill the session (the same trap as replayed cap text).
    const watchNoConversation =
      options.args.includes('--continue') || options.args.includes('-c');
    let totalOutput = 0;

    const safeKill = (): void => {
      try {
        if (!exited) child.kill();
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
      void options
        .verifyCap(snapshot)
        .then((confirmed) => {
          verifying = false;
          if (exited || capped || switching) return;
          if (confirmed) {
            capped = { reason: hit.reason, resetAt: hit.resetAt };
            setTimeout(safeKill, 150);
          } else {
            suppressUntil = Date.now() + 20_000;
          }
        })
        .catch(() => {
          verifying = false;
          suppressUntil = Date.now() + 20_000;
        });
    });

    const stdin = process.stdin as NodeJS.ReadStream & {
      setRawMode?: (v: boolean) => void;
      isTTY?: boolean;
    };
    // A real Windows console reports isTTY; Git Bash/MinTTY does not but still
    // needs raw mode where available. Try regardless and ignore failures.
    try {
      stdin.setRawMode?.(true);
    } catch {
      /* not a raw-capable stdin (e.g. a pipe) */
    }
    stdin.resume();
    const onInput = (d: Buffer): void => {
      // Normalize Enter: terminals may send \r\n or lone \n, but the TUI submits
      // on \r. Without this, typing works but Enter never sends (MinTTY).
      const text = d.toString('utf8').replace(/\r?\n/g, '\r');
      child.write(text);
    };
    stdin.on('data', onInput);

    const onResize = (): void => {
      child.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
    };
    process.stdout.on('resize', onResize);

    const exitSub = child.onExit(({ exitCode }) => {
      exited = true;
      dataSub.dispose();
      exitSub.dispose();
      if (switchPoll) clearInterval(switchPoll);
      stdin.off('data', onInput);
      process.stdout.off('resize', onResize);
      if (stdin.isTTY) stdin.setRawMode?.(false);
      stdin.pause();
      // Release everything that can keep the event loop alive after the child
      // is gone: piped stdin (non-TTY hosts) and the ConPTY handles node-pty
      // holds. Without this the ccx process can hang after a finished session.
      (stdin as unknown as { unref?: () => void }).unref?.();
      try {
        child.kill();
      } catch {
        /* already disposed */
      }
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
    });
  });
}
