import { getAccount } from '../accounts/registry.js';
import { loadLedger, saveLedger, markCapped, clearAccount } from '../ledger/ledger.js';
import type { CliContext } from '../context.js';

export interface CapOptions {
  /** A parseable time (ISO or anything Date.parse accepts) the cap resets at. */
  until?: string;
  /** Alternative to --until: minutes from now. */
  minutes?: string;
  /** Clear the cap instead of setting one. */
  clear?: boolean;
}

/** Manually mark an account capped (or clear it) in the ledger. */
export function capCommand(context: CliContext, name: string, options: CapOptions = {}): number {
  if (!getAccount(name, context.ctx)) {
    context.out(`account "${name}" not found`);
    return 1;
  }

  const ledger = loadLedger(context.ctx);

  if (options.clear) {
    saveLedger(clearAccount(ledger, name), context.ctx);
    context.out(`cleared cap for "${name}"`);
    return 0;
  }

  let resetAt: number | null = null;
  if (options.until) {
    const parsed = Date.parse(options.until);
    if (Number.isNaN(parsed)) {
      context.out(`could not parse --until "${options.until}"`);
      return 1;
    }
    resetAt = parsed;
  }

  const backoffMinutes = options.minutes
    ? Number(options.minutes)
    : context.config.rotation.defaultBackoffMinutes;

  saveLedger(
    markCapped(ledger, {
      account: name,
      now: Date.now(),
      resetAt,
      backoffMinutes,
      reason: 'manual cap',
    }),
    context.ctx,
  );
  context.out(`marked "${name}" capped${resetAt ? ` until ${new Date(resetAt).toISOString()}` : ''}`);
  return 0;
}
