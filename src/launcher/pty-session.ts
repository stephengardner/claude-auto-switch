import { execFileSync } from 'node:child_process';
import { resetChildTerminalModes } from '../ui/child-terminal-modes.js';
import type { IPty } from 'node-pty';
import { nodePty } from '../util/native-pty.js';
import { matchesCapText, resetAtIn } from './cap-detect.js';
import { createRefusalFollower, type Refusal } from '../session/transcript.js';
import { invokerArgs, type ClaudeInvoker } from '../invoker.js';
import { writeSecretFile } from '../util/secret-file.js';
import { normalizeExitCode } from './exit-code.js';
import { createBlockedWatch, type BlockedWatchOptions } from './blocked-watch.js';
import { createCapOutcome } from './cap-outcome.js';
import { openTerminalInput, type TerminalInput } from './terminal-input.js';
import type { SessionOutcome } from './hot-swap.js';
import { wantsExistingConversation, conversationIdIn } from './conversation.js';
import { idleForMs, readLiveConversation, readLiveStatus } from '../session/live-conversation.js';
import { ACCOUNT_ENV, withoutEnv } from './child-env.js';
import { createCarryOn, type CarryOn, type CarryOnTiming } from './carry-on.js';
import { createKeyboardWatch } from './keyboard-watch.js';
import { createPasteModeWatch, pasteAndSend } from './paste-mode.js';

/** What a confirmed limit was met by, and what can be done about it under the live child. */
export interface CapContext {
  /** Whether the account may be changed under the live child. */
  relieve: boolean;
  /** A manual switch is already taking over. */
  switching: boolean;
  /**
   * A subagent met the limit and the main thread has not. Ending the child on
   * that would lose every other subagent with it, so the answer is the move in
   * place or nothing.
   */
  sidechain: boolean;
  /**
   * Whether a prompt can be typed into this Claude at all: it says what it is
   * doing, so the moment it is at its prompt can be known, and it reads a
   * marked paste as text.
   */
  canType: boolean;
}

export type CapDecision =
  /** End the child so the swap loop relaunches on the next account. */
  | { kind: 'restart' }
  /** Nothing was done; the child runs on as it was. */
  | { kind: 'left' }
  /** Moved to `account` under the live child, with a prompt to type into it if one is due. */
  | { kind: 'relieved'; account: string; carryOn?: { prompt: string; canRelaunch: boolean } };

/** What became of a carry-on prompt handed to the live session, for the log. */
export type CarryOnEvent =
  | { kind: 'typed' }
  | { kind: 'refused' }
  | { kind: 'done'; outcome: 'delivered' | 'attended' | 'left'; why: string }
  | { kind: 'relaunch'; why: string };

type Hit = { reason?: string; resetAt?: number };

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
   * Given a CONFIRMED account limit while the child is still alive, try to move
   * the session to a healthy account IN PLACE (swap the credential under the live
   * process) instead of ending it. Returns 'relieved' when it did (the child
   * keeps running on the new account, and its next request goes there), or
   * 'restart' when no in-place move is possible and the session should end so the
   * swap loop can relaunch on the next account, resuming the conversation.
   *
   * This is what stops an account cap from clobbering a running session: real
   * Claude stays on screen after a usage limit, so the account underneath it can
   * be swapped and the very next message succeeds on the new one. When absent
   * (or when it returns 'restart'), the historical end-and-relaunch path runs.
   *
   * `relieve` says whether it may move the account in place; `switching` tells it
   * a manual switch is already taking over. It records the cap to the ledger
   * itself ONLY when there will be no `capped` outcome to do so (a completed
   * in-place relief, or a preempting switch), which it decides from what actually
   * happened; otherwise the caller confirms the cap and the swap loop records it,
   * so the ledger is written exactly once.
   *
   * A relief can come with a prompt for the session, which is typed into the
   * live child once that is safe (see carry-on).
   */
  onCapConfirmed?: (hit: Hit, context: CapContext) => CapDecision;
  /** Told what became of a prompt handed over with a relief. */
  onCarryOn?: (event: CarryOnEvent) => void;
  /**
   * The account the session is on right now. Asked when a session is ended to
   * be relaunched with its prompt, which can be minutes after the move that
   * left the prompt: a switch somebody made in between (it is not told to this
   * layer) must not be undone by relaunching on the account the move went to.
   */
  currentAccount?: () => string;
  /** How long each step of typing that prompt waits. Injected in tests; production uses the defaults in carry-on. */
  carryOnTiming?: Partial<CarryOnTiming>;
  /**
   * Thresholds for deciding the session is blocked. Injected in tests so the
   * pattern can be reached in seconds instead of minutes; production uses the
   * defaults in blocked-watch.
   */
  blockedWatch?: BlockedWatchOptions;
  /**
   * Whether a newer ccx is installed and waiting to take this session over.
   * When it is, Claude is ended once it has been idle a while (from its own
   * record, never mid-turn), and the outcome says so (`handover`).
   */
  handoverWhenIdle?: () => boolean;
  /**
   * How long a REFUTED match backs off before another probe. Injected in tests
   * so the case where a wall recurs AFTER the backoff has expired can be
   * reached in seconds; production uses 20s.
   */
  refuteBackoffMs?: number;
  /**
   * Told which conversation the child is in whenever that changes, in Claude's
   * own words (see session/live-conversation). Checked on the poll and once
   * more just before ccx ends the child: Claude deletes its record as it
   * exits, and a `/resume` made a moment before a swap must not be missed.
   */
  onConversation?: (id: string) => void;
}

/**
 * The operator's environment, less the variables that choose an account: the
 * session runs as the account ccx installed (or the token ccx passes in
 * `extra`), never as one a login variable inherited from elsewhere names.
 */
export function cleanEnv(extra: Record<string, string>, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { ...withoutEnv(env, ACCOUNT_ENV), ...extra };
}

/**
 * Run a claude session inside a pseudo-terminal, relaying it transparently to
 * the operator's terminal (so the TUI still sees a real terminal) while watching
 * the output stream for the rate-limit signal. Resolves 'capped' (and ends the
 * child) when the cap appears, or 'ok' on a normal exit.
 */
export function runPtySession(options: PtySessionOptions): Promise<SessionOutcome> {
  return new Promise((resolve) => {
    const child: IPty = nodePty().spawn(options.claude.bin, invokerArgs(options.claude, options.args), {
      name: process.env.TERM ?? 'xterm-256color',
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      cwd: process.cwd(),
      env: cleanEnv({ CLAUDE_CONFIG_DIR: options.configDir, ...(options.env ?? {}) }),
    });

    const startedAt = Date.now();
    // The rule about which limit answer wins lives in cap-outcome, not here.
    const cap = createCapOutcome();
    /**
     * Is the SESSION getting anywhere, asked without reference to any probe.
     * See blocked-watch: every other guard here resolves uncertainty to "do not
     * act", so something has to be able to say "still stuck" that none of them
     * can veto.
     */
    const blockedWatch = createBlockedWatch(options.blockedWatch);
    const refuteBackoffMs = options.refuteBackoffMs ?? 20_000;
    /**
     * A match that was seen but never probed, because a backoff or an in-flight
     * probe was in the way.
     *
     * Held rather than discarded. Clearing the rolling buffer at the hit stops
     * one message being read as many, but a GENUINE cap can land inside the
     * backoff right after a refuted replay, and if the child then exits this is
     * the only surviving record of it. Without this the exit-time probe reads an
     * empty buffer and the session resolves "ok" on a real limit.
     */
    let unprobed: { text: string; hit: Hit } | null = null;
    /**
     * A confirmed account limit waiting for the grace period to decide seamless
     * relief vs restart (see the deferral where this is set). Cleared by
     * attemptCapRelief, which either swaps the account under the live child or
     * falls through to the confirm-and-kill restart path.
     */
    let pendingCapRelief: (Hit & { sidechain: boolean }) | null = null;
    /**
     * Until when a subagent's refusals are not asked about again. Kept apart
     * from the main thread's backoff: several subagents fail on one limit
     * within seconds, and the answer to the first stands for all of them, but
     * it must not make the main thread's own refusal wait.
     */
    let sidechainQuietUntil = 0;
    /**
     * The main thread was refused while a subagent's refusal was being checked,
     * and that refusal is held in `unprobed`. It is not settled by the
     * subagent's answer: if the session is moved, its main thread has stopped
     * on the old account and must be told to carry on; if it is not moved,
     * the main thread's refusal gets a check and a decision of its own.
     */
    let mainRefusedMeanwhile = false;
    /** A prompt waiting to be typed into this child, after a move in place. */
    let carryOn: CarryOn | null = null;
    /** The account that move went to, for a caller that does not say where the session is now. */
    let carryOnAccount = '';
    /** What the person has typed into this child, from what the relay forwards. */
    const keyboard = createKeyboardWatch();
    /** Whether this child reads a marked paste as text. */
    const pasteMode = createPasteModeWatch();
    /** When Claude last recorded a prompt typed at its terminal. */
    let lastPromptAt = 0;
    /** When a subagent's record was last seen to grow: it was running then. */
    let subagentWroteAt = 0;
    /**
     * How long an UNPROVEN limit holds a pairing out of rotation.
     *
     * Nothing was measured, so there is no window to report. Long enough to
     * move off this account and model, short enough that being wrong costs a
     * couple of minutes rather than the hours a confirmed cap buys.
     */
    const UNPROVEN_HOLD_MS = 2 * 60_000;
    /**
     * How long a confirmed cap waits before it is relieved in place.
     *
     * Set longer than the exit handler's own settle (250ms) so that when Claude
     * exits ITSELF on the limit, the exit path confirms the cap and hands it to
     * the restart rotation FIRST; only a child still alive after this grace is
     * swapped in place. The banner is already on screen and the operator has to
     * read it and type again, so this delay is invisible.
     */
    const RELIEF_GRACE_MS = 400;
    let noConversation = false;
    /** The conversation's own record, read as it grows (see session/transcript). */
    // A launch that starts a new conversation reads its record whole; one that
    // resumes skips the history it brings with it.
    const record = createRefusalFollower(options.configDir, !wantsExistingConversation(options.args));
    /** Whether that record can be read yet. Until it can, the screen stands in for it. */
    let recordReadable = false;
    let window = '';
    let captured = '';
    let switching: string | null = null;
    let exited = false;
    let verifying = false;
    let suppressUntil = 0;
    let lastHit: (Hit & { sidechain: boolean }) | null = null;
    let pendingVerify: Promise<boolean> | null = null;
    let finalized = false;
    // The "No conversation found to continue" error only matters on a resuming
    // launch, and the real one prints in the FIRST flush of output. Watching any
    // longer would let a REPLAYED conversation that merely contains that phrase
    // kill the session (the same trap as replayed cap text).
    // Shared with the retry that strips these flags, so the check that decides
    // "this was a resume" and the code that undoes a resume cannot disagree.
    const watchNoConversation = wantsExistingConversation(options.args);
    /** The conversation this launch resumes by id, the one "not found" would name. */
    const resumedId = conversationIdIn(options.args);
    let totalOutput = 0;

    /**
     * Is the child process genuinely still running?
     *
     * Asked of the OS (`kill(0)`), because node-pty's exit event is not prompt on
     * Windows: it can arrive up to a second after the process is already gone, so
     * the `exited` flag is not a reliable "is it alive right now" for a decision
     * that must not swap an account under a dead child. Falls back to the flag
     * when there is no pid to check.
     */
    const childIsAlive = (): boolean => {
      const pid = child.pid;
      if (!pid) return !exited;
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        // EPERM means it exists but is owned by someone else, which still counts.
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    };

    let lastConversation: string | null = null;
    /** Ask Claude which conversation the child is in, and pass on a change. */
    const noteConversation = (): void => {
      if (!options.onConversation || !child.pid) return;
      const id = readLiveConversation(options.configDir, child.pid, startedAt);
      if (!id || id === lastConversation) return;
      lastConversation = id;
      options.onConversation(id);
    };

    /** A refusal as evidence: Claude's own codes, and the wording for the checks that read it. */
    const hitOf = (refusal: Refusal): { text: string; hit: Hit } => {
      const resetAt = resetAtIn(refusal.text);
      return {
        text: refusal.text,
        hit: { reason: refusal.apiError ?? refusal.error, ...(resetAt !== undefined ? { resetAt } : {}) },
      };
    };

    /**
     * Hand on each turn the conversation's record says was refused, once. This
     * is what decides whether a session hit a wall, whatever the screen says.
     */
    const checkRecord = (): void => {
      if (options.ignoreLimits || cap.isSet() || switching || pendingCapRelief || noConversation) return;
      const seen = record.poll(lastConversation);
      recordReadable = seen.readable;
      // Before the refusals: one that follows a prompt is judged against it.
      if (seen.promptAt !== null) lastPromptAt = Math.max(lastPromptAt, seen.promptAt);
      if (seen.subagentsWrote) subagentWroteAt = Date.now();
      for (const refusal of seen.refusals) {
        const { text, hit } = hitOf(refusal);
        onLimitEvidence(hit, text, refusal.sidechain);
      }
    };

    /** Whether a prompt can be typed into this child at all (see CapContext.canType). */
    const canType = (): boolean =>
      pasteMode.on() && !!child.pid && readLiveStatus(options.configDir, child.pid, startedAt) !== null;

    /**
     * Type the prompt a move in place left for this child, once that is safe,
     * or stop trying. The rule is carry-on's; this only looks and acts.
     */
    const stepCarryOn = (): void => {
      if (!carryOn || exited || !child.pid) return;
      // A limit or a switch being decided owns what happens next.
      if (cap.isSet() || switching || pendingCapRelief || verifying || noConversation) return;
      const now = Date.now();
      const step = carryOn.step({
        now,
        status: readLiveStatus(options.configDir, child.pid, startedAt, now),
        lastKeyAt: keyboard.lastKeyAt(),
        endedOnEnter: keyboard.endedOnEnter(),
        promptAt: lastPromptAt,
        readsPastes: pasteMode.on(),
        subagentWroteAt,
      });
      if (step.do === 'wait') return;
      if (step.do === 'type') {
        child.write(pasteAndSend(carryOn.prompt));
        carryOn.typed(now);
        options.onCarryOn?.({ kind: 'typed' });
        return;
      }
      carryOn = null;
      if (step.do === 'done') {
        options.onCarryOn?.({ kind: 'done', outcome: step.outcome, why: step.why });
        return;
      }
      // Ended at its prompt or behind a dialog, never during a turn, and
      // relaunched on the account it is on now, with the prompt.
      options.onCarryOn?.({ kind: 'relaunch', why: step.why });
      switching = options.currentAccount?.() || carryOnAccount;
      setTimeout(safeKill, 80);
    };

    /**
     * Idle long enough to be a pause, not the gap between two tool calls: a
     * turn in progress is never ended for an update.
     */
    const HANDOVER_IDLE_MS = 20_000;
    let handover = false;
    const checkHandover = (): void => {
      if (handover || exited || cap.isSet() || switching || pendingCapRelief || !child.pid) return;
      // A session that has not yet been told to carry on is idle because it is
      // waiting for that, and the newer ccx would resume it with nothing said.
      if (carryOn) return;
      if (!options.handoverWhenIdle?.()) return;
      const idle = idleForMs(options.configDir, child.pid, startedAt);
      if (idle === null || idle < HANDOVER_IDLE_MS) return;
      handover = true;
      safeKill();
    };

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
      // Last chance to learn the conversation: the record goes with the child.
      noteConversation();
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

    /**
     * Decide a deferred cap: swap the account under the LIVE child (seamless), or
     * fall back to confirm-and-kill so the swap loop relaunches.
     *
     * Runs after RELIEF_GRACE_MS. If the child has since exited, switched, or the
     * cap was already confirmed by the exit path, there is nothing to do here and
     * the restart rotation owns it. Otherwise the child is genuinely still alive
     * (the stay-on-screen limit flavor), so onCapConfirmed swaps its account in
     * place and the next request goes to the new one, no restart.
     */
    const attemptCapRelief = (): void => {
      const pending = pendingCapRelief;
      pendingCapRelief = null;
      if (!pending || cap.isSet()) return;
      // Liveness is asked of the OS, not of the `exited` flag: node-pty's exit
      // EVENT lags the process by up to a second on Windows (measured), so the
      // flag can still read alive well after the child is gone. `kill(0)` reports
      // the truth within ~100ms. A dead child cannot be relieved in place (there
      // is nothing left to run on the new account), and a manual switch already
      // taking over owns the outcome, so neither may be relieved.
      const alive = childIsAlive();
      const relieve = !switching && alive;
      // onCapConfirmed decides for itself whether to record, from what it actually
      // did (relieved, or a switch is taking over -> it records; otherwise the
      // cap.confirm below yields the `capped` outcome and the swap loop records).
      const decision: CapDecision = options.onCapConfirmed?.(pending, {
        relieve,
        switching: switching !== null,
        sidechain: pending.sidechain,
        canType: relieve && canType(),
      }) ?? { kind: 'restart' };
      if (decision.kind === 'relieved') {
        // Swapped under the running child. Clear the watch so the banner still on
        // screen (and any replay) does not immediately re-trigger, and drop the
        // held match now that it has been acted on.
        window = '';
        suppressUntil = Date.now() + refuteBackoffMs;
        unprobed = null;
        blockedWatch.changed();
        carryOnAccount = decision.account;
        carryOn = decision.carryOn
          ? createCarryOn({
              prompt: decision.carryOn.prompt,
              movedAt: Date.now(),
              // The main thread stopped on the limit unless only a subagent met
              // it: now, while the subagent's was checked, or at the move this
              // one follows.
              stalled: !pending.sidechain || mainRefusedMeanwhile || (carryOn?.isStalled() ?? false),
              canRelaunch: decision.carryOn.canRelaunch,
              ...(options.carryOnTiming ? { timing: options.carryOnTiming } : {}),
            })
          : null;
        // Settled by the move: it was refused on the account the session left.
        mainRefusedMeanwhile = false;
        return;
      }
      // A subagent met it and the session could not be moved in place. Nothing
      // ends on a subagent's word: the main thread meets the limit itself at its
      // next request, and that refusal takes the path below.
      if (decision.kind === 'left' || pending.sidechain) {
        sidechainQuietUntil = Date.now() + refuteBackoffMs;
        checkMainRefusedMeanwhile();
        return;
      }
      // Not relieved. A manual switch owns the teardown and relaunch, so leave it
      // be (the cap is already recorded). Otherwise confirm and end so the swap
      // loop relaunches on the next account.
      if (!switching) {
        cap.confirm(pending);
        // Kill ONLY a child that is genuinely still alive. When it is already gone
        // (its exit event just lags, which is why we ask the OS and not `exited`),
        // safeKill would run taskkill on a dead pid and fall through to node-pty's
        // own kill, re-entering its async Windows teardown and racing the next
        // spawn. The lagging exit event will resolve the confirmed cap. Liveness is
        // re-checked INSIDE the timer, not reused from `alive` above, because the
        // child can exit during the 150ms wait.
        if (alive && !exited) {
          setTimeout(() => {
            if (childIsAlive() && !exited) safeKill();
          }, 150);
        }
      }
    };

    // The operator can pick a different account mid-session (dashboard Enter /
    // `ccx use`); poll for that and end the child so the swap loop relaunches
    // resume this conversation on the chosen account, in place.
    let ticks = 0;
    const switchPoll =
      options.switchWatch || options.onConversation
        ? setInterval(() => {
          // Housekeeping FIRST, and never behind the early return below. The
          // session's "I am still using this account" heartbeat used to ride
          // inside switchWatch, so the moment a cap or a pending switch short
          // circuited this poll the session went quiet and its protection could
          // lapse while it was still running.
          options.onTick?.();
          // Every third tick: the conversation changes at human speed, and a
          // swap reads it once more before ending the child anyway.
          if (ticks++ % 3 === 0) {
            noteConversation();
            checkRecord();
            checkHandover();
          }
          stepCarryOn();
          if (!options.switchWatch || cap.isSet() || switching || noConversation) return;
          const target = options.switchWatch();
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
      pasteMode.observe(data);
      if (options.debugLog) captured += data;
      // `pendingCapRelief` is part of this guard so a cap episode is handled
      // ONCE. Without it, more banner output during the relief grace could start
      // a SECOND verification; if that resolved after the swap, it would call
      // onCapConfirmed again with the account already moved to the healthy relief
      // target, record THAT account as capped, and rotate off it. A confirmed cap
      // being decided suppresses new matches until attemptCapRelief clears it,
      // the same way an already-set cap or a pending switch does.
      if (cap.isSet() || switching || pendingCapRelief) return;
      totalOutput += data.length;
      window = (window + data).slice(-4000);
      // A resume with nothing to resume: signal a fresh relaunch is needed.
      if (
        watchNoConversation &&
        totalOutput <= 6000 &&
        // `--continue` with nothing in the folder, or `--resume <id>` for a
        // conversation that was never written: a swap before the first message
        // has nothing on disk yet. Both exit at once, and treating the second
        // as an ordinary exit ended the operator's session on a swap. The
        // second is matched with the id this launch asked for, so a replayed
        // conversation that merely mentions the message cannot end it.
        (/No conversation found to continue/i.test(window) ||
          (resumedId !== null && window.includes(`No conversation found with session ID: ${resumedId}`)))
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
      // The conversation's own record decides once it can be read (see
      // checkRecord): the screen only stands in for it until then.
      if (options.ignoreLimits || recordReadable) return;
      const hit = matchesCapText(window);
      if (!hit) return;
      // Cleared HERE, before anything can return early. One message is one
      // episode, and leaving it in the rolling buffer means the next unrelated
      // output re-matches the same text: three checks of a single wall would
      // then look like three walls and raise a hold nobody hit.
      const snapshot = window;
      window = '';
      onLimitEvidence(hit, snapshot, false);
    });

    /**
     * What to make of a refused turn, however it was seen: in the
     * conversation's own record, or on screen while that cannot be read yet.
     *
     * `sidechain`: a subagent met it. That is the same account's limit, and it
     * starts the same check and the same move in place, so the main thread
     * and the other subagents carry on with their next request. It is never a
     * reason to end the child, which is what loses them: so it neither counts
     * toward "this session is stuck" nor is kept for the exit path, and when
     * nothing can confirm it, it is dropped.
     */
    const onLimitEvidence = (hit: Hit, snapshot: string, sidechain: boolean): void => {
      if (sidechain) {
        if (Date.now() < sidechainQuietUntil) return;
      } else {
        // The main thread stopped on a refusal. If a prompt was just typed
        // into it, that prompt is what was refused: Claude was still on the
        // login it had, or the account it moved to is out as well, which the
        // check below says.
        if (carryOn) {
          carryOn.refused(Date.now(), lastPromptAt);
          options.onCarryOn?.({ kind: 'refused' });
        }
        // Counted BEFORE the suppression below, and that ordering is the whole
        // point. A hit arriving inside the refute backoff, or while a probe was
        // in flight, used to return above this line and never be seen at all: the
        // one signal that says "this session is STILL stuck" was thrown away to
        // avoid re-probing. So the session could be walled off indefinitely while
        // every guard agreed there was nothing to act on. With the record read,
        // each of these is a turn the API really refused.
        if (blockedWatch.sawLimitText(Date.now()) && !switching) {
          cap.hold({
            reason: hit.reason ?? 'the same limit keeps coming back and nothing explains it',
            resetAt: Date.now() + UNPROVEN_HOLD_MS,
          });
          if (!exited) setTimeout(safeKill, 150);
          return;
        }
      }
      checkRefusal(hit, snapshot, sidechain);
    };

    /**
     * The main thread's refusal held while a subagent's was checked, now that
     * that check ended without moving the session: it gets its own check and
     * its own decision, as if it had come just now. Without this it waited
     * for Claude to exit, and the session sat on the spent account.
     */
    const checkMainRefusedMeanwhile = (): void => {
      if (!mainRefusedMeanwhile) return;
      mainRefusedMeanwhile = false;
      const held = unprobed;
      if (!held || exited || switching || cap.isSet()) return;
      checkRefusal(held.hit, held.text, false);
    };

    /** Ask the account about a refusal, or hold it while that cannot be done yet. */
    const checkRefusal = (hit: Hit, snapshot: string, sidechain: boolean): void => {
      if (verifying || Date.now() < suppressUntil) {
        if (!sidechain) {
          unprobed = { text: snapshot, hit };
          if (verifying && lastHit?.sidechain) mainRefusedMeanwhile = true;
        }
        return;
      }
      if (!sidechain) unprobed = null;
      if (!options.verifyCap) {
        if (sidechain) return;
        cap.confirm({ reason: hit.reason, resetAt: hit.resetAt });
        setTimeout(safeKill, 150);
        return;
      }
      /** Not confirmed: do not ask again for a while, about the same kind of refusal. */
      const backOff = (): void => {
        if (sidechain) sidechainQuietUntil = Date.now() + refuteBackoffMs;
        else suppressUntil = Date.now() + refuteBackoffMs;
      };
      verifying = true;
      lastHit = { reason: hit.reason, resetAt: hit.resetAt, sidechain };
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
            if (!sidechain) blockedWatch.changed();
            // Overwrites whatever is there, and that matters when the thing
            // there is the unproven two-minute hold this watch sets. A probe
            // still in flight when the hold lands would otherwise have its
            // CONFIRMED reason and reset time thrown away, and the pairing
            // would come back into rotation minutes before the real limit
            // expires, straight into the same wall.
            if (!switching) {
              // Try to move the session to a healthy account IN PLACE rather than
              // ending it. But NOT here, inline: some limit flavors make Claude
              // exit ITSELF, and that exit races this verdict, so acting now would
              // swap the account under a child that is already gone and end the
              // session on it without ever running. Defer to a short grace: if the
              // child exits in that window this stays the restart path (the exit
              // handler confirms the cap and the loop relaunches, resuming the
              // conversation), and only a child still alive afterwards gets the
              // seamless swap. `unprobed` keeps the match recoverable so the exit
              // handler can still confirm it if the child dies first.
              if (options.onCapConfirmed && !exited) {
                pendingCapRelief = { reason: hit.reason, resetAt: hit.resetAt, sidechain };
                if (!sidechain) unprobed = { text: snapshot, hit };
                setTimeout(attemptCapRelief, RELIEF_GRACE_MS);
                return confirmed;
              }
              // Nothing here can move it in place, and a subagent's refusal
              // ends nothing.
              if (sidechain) {
                backOff();
                checkMainRefusedMeanwhile();
                return confirmed;
              }
              cap.confirm({ reason: hit.reason, resetAt: hit.resetAt });
              if (!exited) setTimeout(safeKill, 150);
            } else if (options.onCapConfirmed) {
              // A manual switch became active WHILE this verification was in
              // flight, so it owns the outcome (which will resolve as a plain
              // switch, recording nothing). The confirmed cap must still reach the
              // ledger, or the account re-enters rotation before its reset. Record
              // it here, the same way a switch preempting the relief grace does.
              options.onCapConfirmed({ reason: hit.reason, resetAt: hit.resetAt }, {
                relieve: false,
                switching: true,
                sidechain,
                canType: false,
              });
            }
          } else {
            backOff();
            if (sidechain) checkMainRefusedMeanwhile();
          }
          return confirmed;
        })
        .catch(() => {
          verifying = false;
          backOff();
          if (sidechain) checkMainRefusedMeanwhile();
          return false;
        });
    };

    // Borrow the keyboard from the run's owner (or the one claimed above when
    // running standalone, e.g. in tests). Attaching is what starts keystrokes
    // flowing to THIS child, and it resets anything held for the last one.
    const detachInput = input.attach((text) => {
      keyboard.saw(text, Date.now());
      child.write(text);
    });

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
            : cap.get()
              ? {
                  kind: 'capped',
                  exitCode,
                  reason: cap.get()!.reason,
                  resetAt: cap.get()!.resetAt,
                  ranMs,
                  ...(cap.isConfirmed() ? {} : { unproven: true as const }),
                }
              : noConversation
                ? { kind: 'no-conversation', exitCode, ranMs }
                : { kind: 'ok', exitCode, ranMs, ...(handover ? { handover: true as const } : {}) },
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
        // A cap was already CONFIRMED and was only waiting for the relief grace
        // when the child exited (some limit flavors make Claude exit itself). The
        // verdict is in hand, so trust it rather than re-probing: re-probing here
        // would spend a second verification and, when the API answer has moved on,
        // wrongly read the exit as clean. Record it always (relieve:false: the
        // child is gone, nothing to swap under), so the limit is on the ledger
        // even if a manual switch owns the outcome; and unless a switch does own
        // it, confirm so the swap loop relaunches on the next account, resuming.
        if (pendingCapRelief) {
          // The child is gone, so no relief. onCapConfirmed records only when a
          // manual switch owns the outcome (no `capped` outcome will follow);
          // otherwise the cap.confirm below produces the `capped` outcome and the
          // swap loop records it, so it must not double-write.
          options.onCapConfirmed?.(pendingCapRelief, {
            relieve: false,
            switching: switching !== null,
            sidechain: pendingCapRelief.sidechain,
            canType: false,
          });
          // A session that ended is relaunched for a limit its main thread met,
          // never for one only a subagent did: it may simply have been closed.
          if (!switching && !pendingCapRelief.sidechain) cap.confirm(pendingCapRelief);
          pendingCapRelief = null;
        }
        // A capped outcome waits for a probe that is still in flight. The
        // fallback hold schedules a kill 150ms later, so without this the exit
        // handler finalizes first and a probe resolving afterwards can never
        // replace the unproven two-minute hold with the confirmed window: the
        // outcome has already resolved. Bounded, because the probe aborts at 8s
        // and the wait below is timeboxed at 12s.
        if (switching || noConversation || (cap.isSet() && !verifying)) return finalize();
        const timeboxed = (p: Promise<boolean>): Promise<boolean> =>
          Promise.race([p, new Promise<boolean>((r) => setTimeout(() => r(false), 12_000))]);
        // Only while it is genuinely still running. A settled promise here is
        // a refusal that already happened, and awaiting it again would finalize
        // without ever looking at a match that arrived afterwards.
        /**
         * The last chance to catch a real limit: the match that was held
         * because something was in the way, else whatever is still in the
         * buffer. Deliberately ignores the refute backoff, since the child is
         * gone and there will be no other opportunity.
         */
        const verifyHeldThenFinalize = (): void => {
          // One last read of the record, for a refusal written just before the
          // exit; the screen only counts while the record could not be read.
          const final = options.ignoreLimits ? null : record.poll(lastConversation);
          if (final?.readable) recordReadable = true;
          // The main thread's only, as above.
          const lastRefusal = final?.refusals.filter((refusal) => !refusal.sidechain).pop();
          const recorded = lastRefusal ? hitOf(lastRefusal) : null;
          const live = recordReadable ? null : matchesCapText(window);
          const pending = unprobed ?? recorded ?? (live ? { text: window, hit: live } : null);
          if (pending && options.verifyCap) {
            void timeboxed(options.verifyCap(pending.text).catch(() => false)).then((confirmed) => {
              if (confirmed) {
                cap.confirm({ reason: pending.hit.reason, resetAt: pending.hit.resetAt });
              }
              finalize();
            });
            return;
          }
          if (pending && !options.verifyCap) {
            cap.confirm({ reason: pending.hit.reason, resetAt: pending.hit.resetAt });
          }
          finalize();
        };

        if (pendingVerify && verifying) {
          void timeboxed(pendingVerify).then((confirmed) => {
            if (confirmed && !lastHit?.sidechain) {
              cap.confirm(lastHit ?? {});
              return finalize();
            }
            // Refuted, which settles that match and NOTHING ELSE. A genuine cap
            // can have arrived while this probe was running and been held
            // rather than probed; finalizing here threw it away and resolved a
            // real limit as a clean exit.
            verifyHeldThenFinalize();
          });
          return;
        }
        verifyHeldThenFinalize();
      }, 250);
    });
  });
}
