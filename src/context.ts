import { loadConfig } from './config/config.js';
import { resolveRealClaude } from './launcher/real-claude.js';
import type { Config } from './config/config.schema.js';
import type { PathCtx } from './config/paths.js';
import type { ClaudeInvoker } from './invoker.js';
import type { LimitVerdict } from './usage/limit-probe.js';
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

/** Resolve the claude invoker lazily so commands that never touch claude never look it up. */
export function getClaude(context: CliContext): ClaudeInvoker {
  return (
    context.claude ??
    resolveRealClaude({ config: context.config, platform: context.ctx.platform })
  );
}
