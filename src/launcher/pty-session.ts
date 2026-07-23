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

    const dataSub = child.onData((data) => {
      process.stdout.write(data);
      if (options.debugLog) captured += data;
      if (capped) return;
      window = (window + data).slice(-4000);
      const hit = matchesCapText(window);
      if (hit) {
        capped = { reason: hit.reason, resetAt: hit.resetAt };
        window = '';
        // Let the limit message finish rendering, then end the child so we swap.
        setTimeout(() => child.kill(), 150);
        return;
      }
      // A --continue with nothing to resume: signal a fresh relaunch is needed.
      if (/No conversation found to continue/i.test(window)) {
        noConversation = true;
        setTimeout(() => child.kill(), 100);
      }
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
      dataSub.dispose();
      exitSub.dispose();
      stdin.off('data', onInput);
      process.stdout.off('resize', onResize);
      if (stdin.isTTY) stdin.setRawMode?.(false);
      stdin.pause();
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
        capped
          ? { kind: 'capped', exitCode, reason: capped.reason, resetAt: capped.resetAt }
          : noConversation
            ? { kind: 'no-conversation', exitCode }
            : { kind: 'ok', exitCode },
      );
    });
  });
}
