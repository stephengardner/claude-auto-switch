import path from 'node:path';
import { loadConfig } from './config/config.js';
import { resolveRealClaude } from './launcher/real-claude.js';
import {
  REPAIR_LOCK,
  REPAIR_MEMORY,
  REPAIR_SIZES,
  resolveClaudeForLaunch,
  type LaunchDeps,
} from './launcher/claude-repair.js';
import type { Config } from './config/config.schema.js';
import { configHome, type PathCtx } from './config/paths.js';
import type { ClaudeInvoker } from './invoker.js';
import type { LimitProbeResult, LimitVerdict } from './usage/limit-probe.js';
import type { BlockedWatchOptions } from './launcher/blocked-watch.js';
import type { NewerInstall } from './update/newer-install.js';
import type { CarryOnTiming } from './launcher/carry-on.js';
import type { ConfirmCapDeps } from './usage/confirm-cap.js';

/** Everything a command needs: paths context, config, output sink, and flags. */
export interface CliContext {
  ctx: PathCtx;
  config: Config;
  /** Injected in tests; resolved lazily from config otherwise (see getClaude). */
  claude?: ClaudeInvoker;
  /** Injected in tests: overrides the API limit verification (usage/limit-probe). */
  verifyCap?: (renderedText: string) => Promise<LimitVerdict>;
  /**
   * Injected in tests: stands in for the live usage request only, keeping
   * what `verifyCap` replaces whole (which login is asked, and whose limit it
   * turns out to be).
   */
  capProbe?: ConfirmCapDeps['probe'];
  /**
   * Injected in tests: stands in for the usage request that asks whether a
   * stored login's token is still accepted (accounts/login-check), so no test
   * sends a made-up token to Anthropic.
   */
  loginProbe?: (credentialsFile: string) => Promise<LimitProbeResult>;
  /**
   * Injected in tests: how quickly a session counts as blocked. Production uses
   * the defaults in blocked-watch (three walls over two minutes), which no test
   * can wait for.
   */
  blockedWatch?: BlockedWatchOptions;
  /**
   * Injected in tests: how long each step of typing a carry-on prompt into a
   * live session waits. Production uses the defaults in launcher/carry-on,
   * half a minute and more, which no test can wait for.
   */
  carryOn?: Partial<CarryOnTiming>;
  /**
   * Injected in tests: how long Claude must be idle before ccx ends it for a
   * newer ccx or a switch it cannot make in place. Production waits 20 s.
   */
  idleBeforeRestartMs?: number;
  /**
   * Injected in tests: how long a refused turn goes unchecked after a check
   * that did not confirm a limit, or after a move in place. Production waits
   * 20 s (launcher/pty-session).
   */
  refuteBackoffMs?: number;
  /**
   * Injected in tests: how long a login renewal for a switch that did not
   * happen (another session using the login, an outage) waits before the same
   * switch tries it again. Production waits 20 s.
   */
  moveRenewalRetryMs?: number;
  /**
   * Injected in tests: whether a pid is a live Claude process, for telling
   * another Claude on a conversation (session/other-writers). The fake claude
   * runs as `node`, which the real check would never count.
   */
  isClaudeProcess?: (pid: number) => boolean;
  /**
   * Injected in tests: how often an editor launch reads its Claude's records
   * while it runs. Production reads them as often as a terminal session does.
   */
  editorFollowMs?: number;
  /**
   * Injected in tests: how often a running session looks for a renewal the
   * editor's Claude made of its login. Production looks once a minute.
   */
  editorTakeUpMs?: number;
  /** Injected in tests: overrides the API lookup of who a stored login belongs to. */
  lookupOwner?: (dir: string) => Promise<string | null>;
  /** Injected in tests: a newer ccx installed under this one (update/newer-install). */
  newerInstall?: () => NewerInstall | null;
  /**
   * Injected in tests: how long a session stays on another account for one
   * Artifact call when nothing reports the call over. Production uses the two
   * minutes in artifacts/hop, which no test can wait for.
   */
  artifactHop?: { holdMs?: number };
  /** Injected in tests: whether a folder's login lives in the macOS Keychain (see nudgeLoginReread). */
  loginInKeychain?: (dir: string) => boolean;
  /** Injected in tests: the file system, npm, lock and clock the search for Claude and its repair use. */
  claudeSearch?: Partial<LaunchDeps>;
  out: (message: string) => void;
  /** ccx's own status messages. MUST go to stderr so it never corrupts a run's stdout protocol. */
  err?: (message: string) => void;
  json: boolean;
  quiet: boolean;
}

export interface BuildContextOptions {
  ctx?: PathCtx;
  json?: boolean;
  quiet?: boolean;
  out?: (message: string) => void;
  err?: (message: string) => void;
}

/** Assemble the runtime context for real CLI use. */
export function buildContext(options: BuildContextOptions = {}): CliContext {
  const ctx = options.ctx ?? {};
  return {
    ctx,
    config: loadConfig(ctx),
    out: options.out ?? ((message) => process.stdout.write(`${message}\n`)),
    err: options.err ?? ((message) => process.stderr.write(`${message}\n`)),
    json: options.json ?? false,
    quiet: options.quiet ?? false,
  };
}

/**
 * Resolve the claude invoker lazily so commands that never touch claude never
 * look it up. It is about to be launched, so on Windows an npm install of
 * Claude Code that has lost its program is repaired first (claude-repair).
 */
export function getClaude(context: CliContext): ClaudeInvoker {
  return (
    context.claude ??
    resolveClaudeForLaunch({ config: context.config, ...claudeRepairDeps(context), ...context.claudeSearch })
  );
}

/**
 * What a repair of Claude's install needs from a run. Every repair takes this
 * one lock, the launch's and `ccx doctor --fix`'s alike, so no two overlap.
 */
export function claudeRepairDeps(context: CliContext): {
  platform: NodeJS.Platform | undefined;
  lockFile: () => string;
  memoryFile: () => string;
  sizesFile: () => string;
  say: (message: string) => void;
} {
  return {
    platform: context.ctx.platform,
    lockFile: () => path.join(configHome(context.ctx), REPAIR_LOCK),
    memoryFile: () => path.join(configHome(context.ctx), REPAIR_MEMORY),
    sizesFile: () => path.join(configHome(context.ctx), REPAIR_SIZES),
    say: context.err ?? ((message) => void process.stderr.write(`${message}\n`)),
  };
}

/** The claude invoker as things are, repairing nothing: for commands that only report. */
export function getClaudeAsIs(context: CliContext): ClaudeInvoker {
  return (
    context.claude ??
    resolveRealClaude({ config: context.config, platform: context.ctx.platform, ...context.claudeSearch })
  );
}

/**
 * The claude a session starts. A worker's is never repaired: a repair can block
 * for minutes (npm, the lock) where nothing else runs, and a worker has to end
 * when its --timeout says. It stops at once instead, with the message, which
 * names `ccx doctor --fix`.
 */
export function claudeForSession(context: CliContext, worker: boolean): ClaudeInvoker {
  return worker ? getClaudeAsIs(context) : getClaude(context);
}
