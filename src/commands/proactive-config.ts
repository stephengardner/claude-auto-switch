import { loadConfig, saveConfig } from '../config/config.js';
import type { CliContext } from '../context.js';

/** The percent used when turning this on without naming one. */
export const DEFAULT_PROACTIVE_PERCENT = 90;

export interface ProactiveConfigOptions {
  percent?: string;
}

/**
 * Turn "move me before I run out" on or off, and show where it stands.
 *
 * Off by default: handing a live session to another account is a real change to
 * what you are working in, so it is opted into rather than assumed.
 */
export function proactiveCommand(
  context: CliContext,
  action: 'on' | 'off' | 'status' | undefined,
  options: ProactiveConfigOptions = {},
): number {
  const current = context.config.rotation.proactivePercent;

  if (!action || action === 'status') {
    if (current > 0) {
      context.out(
        `on: a session moves to a roomier account once the current one reaches ${current}% of the limit that would stop it`,
      );
      context.out('turn it off with: ccx proactive off');
    } else {
      context.out('off: sessions stay on their account until it actually runs out');
      context.out(`turn it on with: ccx proactive on  (defaults to ${DEFAULT_PROACTIVE_PERCENT}%)`);
    }
    return 0;
  }

  let percent = 0;
  if (action === 'on') {
    percent = options.percent === undefined ? DEFAULT_PROACTIVE_PERCENT : Number(options.percent);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      context.out(`--percent must be between 1 and 100 (got "${options.percent}")`);
      return 1;
    }
  }

  // Re-read from disk so unrelated settings written by hand are preserved.
  const onDisk = loadConfig(context.ctx);
  saveConfig({ ...onDisk, rotation: { ...onDisk.rotation, proactivePercent: percent } }, context.ctx);

  context.out(
    percent > 0
      ? `on: sessions will move to a roomier account at ${percent}%`
      : 'off: sessions stay on their account until it actually runs out',
  );
  return 0;
}
