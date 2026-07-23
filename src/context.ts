import { loadConfig } from './config/config.js';
import { resolveRealClaude } from './launcher/real-claude.js';
import type { Config } from './config/config.schema.js';
import type { PathCtx } from './config/paths.js';
import type { ClaudeInvoker } from './invoker.js';

/** Everything a command needs: paths context, config, output sink, and flags. */
export interface CliContext {
  ctx: PathCtx;
  config: Config;
  /** Injected in tests; resolved lazily from config otherwise (see getClaude). */
  claude?: ClaudeInvoker;
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
