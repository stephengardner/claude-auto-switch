import { execFileSync } from 'node:child_process';
import { resetChildTerminalModes } from '../ui/child-terminal-modes.js';
import { spawn, type IPty } from 'node-pty';
import { matchesCapText } from './cap-detect.js';
import { invokerArgs, type ClaudeInvoker } from '../invoker.js';
import { writeSecretFile } from '../util/secret-file.js';
import { normalizeExitCode } from './exit-code.js';
import { createBlockedWatch, type BlockedWatchOptions } from './blocked-watch.js';
import { openTerminalInput, type TerminalInput } from './terminal-input.js';
import type { SessionOutcome } from './hot-swap.js';
import { wantsExistingConversation } from './conversation.js';

export interface PtySessionOptions {
  claude: ClaudeInvoker;
  args: string[];
  /** CLAUDE_CONFIG_DIR for the session (kept constant across swaps so the resume works). */
  configDir: string;
  /** Extra env for this launch (e.g. CLAUDE_CODE_OAUTH_TOKEN for the active account). */
  env?: Record<string, string>;
  /** If set, write the session's raw output here for debugging cap detection. */
  debugLog?: string;
  /**
   * Polled periodically; return an account name when the operator has picked a
   * different account mid-session, and the child is ended so the swap loop
   * relaunches, resuming this conversation on it. Return null to keep running.
   */
  switchWatch?: () => string | null;
  /**
   * Run on every poll, before anything can short-circuit it. For work that must
   * keep happening for as long as the session is alive, whatever else is going
   * on: saying the account is still in use, and copying a refreshed login back.
   */
  onTick?: () => void;
  /**
   * Called when cap-looking text renders, with that text; resolves true ONLY if
   * the account is actually limited (verified against the API). Rendered text
   * alone is untrustworthy: resuming a conversation REPLAYS history,
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
  /**
   * Thresholds for deciding the session is blocked. Injected in tests so the
   * pattern can be reached in seconds instead of minutes; production uses the
   * defaults in blocked-watch.
   */
  blockedWatch?: BlockedWatchOptions;
  /**
   * How long a REFUTED match backs off before another probe. Injected in tests
   * so the case where a wall recurs AFTER the backoff has expired can be
   * reached in seconds; production uses 20s.
   */
  refuteBackoffMs?: number;
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

    const startedAt = Date.now();
    let capped: { reason?: string; resetAt?: number } | null = null;
    /**
     * Is the SESSION getting anywhere, asked without reference to any probe.
     * See blocked-watch: every other guard here resolves uncertainty to "do not
     * act", so something has to be able to say "still stuck" that none of them
     * can veto.
     */
    const blockedWatch = createBlockedWatch(options.blockedWatch);
    const refuteBackoffMs = options.refuteBackoffMs ?? 20_000;
    /**
     * How long an UNPROVEN limit holds a pairing out of rotation.
     *
     * Nothing was measured, so there is no window to report. Long enough to
     * move off this account and model, short enough that being wrong costs a
     * couple of minutes rather than the hours a confirmed cap buys.
     */
    const UNPROVEN_HOLD_MS = 2 * 60_000;
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
    // The "No conversation found to continue" error only matters on a resuming
    // launch, and the real one prints in the FIRST flush of output. Watching any
    // longer would let a REPLAYED conversation that merely contains that phrase
    // kill the session (the same trap as replayed cap text).
    // Shared with the retry that strips these flags, so the check that decides
    // "this was a resume" and the code that undoes a resume cannot disagree.
    const watchNoConversation = wantsExistingConversation(options.args);
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
    // resume this conversation on the chosen account, in place.
    const switchPoll = options.switchWatch
      ? setInterval(() => {
          // Housekeeping FIRST, and never behind the early return below. The
          // session's "I am still using this account" heartbeat used to ride
          // inside switchWatch, so the moment a cap or a pending switch short
          // circuited this poll the session went quiet and its protection could
          // lapse while it was still running.
          options.onTick?.();
          if (capped || switching || noConversation) return;
          const target = options.switchWatch!();
          if (target) {
            switching = target;
            setTimeout(safeKill, 80);
          }
        }, 400)
      : null;

    // Claimed BEFORE the child's output is subscribed to, because that
    // subscription reads it: the child can write the moment it starts, and a
    // relay that is not there yet would miss the very mode declarations it
    // exists to watch for.
    const ownsInput = options.input === undefined;
    const input = options.input ?? openTerminalInput();

    const dataSub = child.onData((data) => {
      process.stdout.write(data);
      // The child's own words are the only honest record of which mouse modes
      // it has asked the terminal for, and every byte of them passes here. The
      // input relay uses that to refuse reports this child cannot have wanted.
      input.observeChildOutput(data);
      if (options.debugLog) captured += data;
      if (capped || switching) return;
      totalOutput += data.length;
      window = (window + data).slice(-4000);
      // A resume with nothing to resume: signal a fresh relaunch is needed.
      if (
        watchNoConversation &&
        totalOutput <= 6000 &&
        /No conversation found to continue/i.test(window)
      ) {
        noConversation = true;
        setTimeout(() => safeKill(), 100);
        return;
      }
      // Cap-looking text is a TRIGGER, never a verdict. A resumed conversation and the
      // resume picker replay history (old cap messages included), and code on
      // screen can mention rate limits; acting on text alone falsely capped
      // every account in turn. Verify against the API and only act when the
      // account is confirmed limited. Refuted matches back off briefly so a
      // replay cannot spam probes.
      if (options.ignoreLimits) return;
      const hit = matchesCapText(window);
      if (!hit) return;
      // Cleared HERE, before anything can return early. One message is one
      // episode, and leaving it in the rolling buffer means the next unrelated
      // output re-matches the same text: three checks of a single wall would
      // then look like three walls and raise a hold nobody hit.
      const snapshot = window;
      window = '';

      // Counted BEFORE the suppression below, and that ordering is the whole
      // point. A hit arriving inside the refute backoff, or while a probe was
      // in flight, used to return above this line and never be seen at all: the
      // one signal that says "this session is STILL stuck" was thrown away to
      // avoid re-probing. So the session could be walled off indefinitely while
      // every guard agreed there was nothing to act on.
      if (blockedWatch.sawLimitText(Date.now()) && !capped && !switching) {
        capped = {
          reason: hit.reason ?? 'the same limit keeps coming back and nothing explains it',
          resetAt: Date.now() + UNPROVEN_HOLD_MS,
        };
        if (!exited) setTimeout(safeKill, 150);
        return;
      }

      if (verifying || Date.now() < suppressUntil) return;
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
            // ONLY on a confirmed cap. Clearing it on every probe result, as
            // this first did, hands the veto straight back to the guard this
            // watch exists to be independent of: a refuted probe backs off for
            // 20s, so any wall recurring more slowly than that gets probed,
            // refuted, and the count reset, for ever. It would have shipped
            // doing nothing at all in the case it was written for.
            blockedWatch.changed();
            // Overwrites whatever is there, and that matters when the thing
            // there is the unproven two-minute hold this watch sets. A probe
            // still in flight when the hold lands would otherwise have its
            // CONFIRMED reason and reset time thrown away, and the pairing
            // would come back into rotation minutes before the real limit
            // expires, straight into the same wall.
            if (!switching) {
              capped = { reason: hit.reason, resetAt: hit.resetAt };
              if (!exited) setTimeout(safeKill, 150);
            }
          } else {
            suppressUntil = Date.now() + refuteBackoffMs;
          }
          return confirmed;
        })
        .catch(() => {
          verifying = false;
          suppressUntil = Date.now() + refuteBackoffMs;
          return false;
        });
    });

    // Borrow the keyboard from the run's owner (or the one claimed above when
    // running standalone, e.g. in tests). Attaching is what starts keystrokes
    // flowing to THIS child, and it resets anything held for the last one.
    const detachInput = input.attach((text) => child.write(text));

    const onResize = (): void => {
      child.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
    };
    process.stdout.on('resize', onResize);

    const exitSub = child.onExit((report) => {
      // Taken here, when the child actually ended. Finalization can wait for a
      // trailing flush and an in-flight limit check, which would be counted as
      // session time it did not run for.
      const ranMs = Date.now() - startedAt;
      // Normalized here, at the only place a pty exit enters ccx: on Windows this
      // report can arrive with no code and no signal at all, and passing that
      // through told the shell "undefined", which reads as success.
      const exitCode = normalizeExitCode(report);
      exited = true;
      exitSub.dispose();
      if (switchPoll) clearInterval(switchPoll);
      // Stop routing keystrokes here, but leave OUR OWN terminal mode alone: the
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
            ? { kind: 'switch', exitCode, switchTo: switching, ranMs }
            : capped
              ? { kind: 'capped', exitCode, reason: capped.reason, resetAt: capped.resetAt, ranMs }
              : noConversation
                ? { kind: 'no-conversation', exitCode, ranMs }
                : { kind: 'ok', exitCode, ranMs },
        );
      };

      // Claude EXITS ITSELF on a session limit, and ConPTY can flush the very
      // output containing that limit message AFTER the exit event. So: give the
      // trailing flush a moment, then settle any in-flight (or newly-triggered)
      // verification BEFORE deciding this was a normal exit. Without this, a
      // real cap raced the async verdict and the whole session ended instead of
      // rotating (the "my session completely terminated" bug).
      setTimeout(() => {
        // The CHILD's modes are put back HERE, after the trailing flush, and
        // nowhere earlier. We end sessions by killing them, which skips the
        // child's exit handler, so the mouse tracking and bracketed paste it
        // switched on stay on and every mouse movement types `;171;15M` into
        // whatever reads input next. Doing this in onExit looked right and was
        // not: the trailing flush arrives AFTER the exit event, and Claude's
        // last redraw re-enabled the very modes the reset had just turned off.
        // That is how the fix shipped and the garbage survived it.
        resetChildTerminalModes();
        // A capped outcome waits for a probe that is still in flight. The
        // fallback hold schedules a kill 150ms later, so without this the exit
        // handler finalizes first and a probe resolving afterwards can never
        // replace the unproven two-minute hold with the confirmed window: the
        // outcome has already resolved. Bounded, because the probe aborts at 8s
        // and the wait below is timeboxed at 12s.
        if (switching || noConversation || (capped && !verifying)) return finalize();
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
