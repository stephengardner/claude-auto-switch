import { listAccounts } from '../accounts/registry.js';
import { loadLedger, cappedNames } from '../ledger/ledger.js';
import { hasLogin } from '../accounts/account-login.js';
import { refreshUsage, type UsageEntry } from './usage-store.js';
import type { ProactiveDeps } from './proactive.js';
import type { UsageLike } from './headroom.js';
import type { CliContext } from '../context.js';

/**
 * Turn a stored usage entry into what the policy reads.
 *
 * Exported and pure because the reset times are the whole point: without them a
 * window that has already lifted still reads as a limit. That wiring is easy to
 * drop by accident and impossible to notice from the policy's own tests, which
 * build their input by hand.
 */
export function toUsageLike(entry: UsageEntry): UsageLike {
  return {
    fiveHour: entry.fiveHour,
    sevenDay: entry.sevenDay,
    fiveHourReset: entry.fiveHourReset,
    sevenDayReset: entry.sevenDayReset,
    ...(entry.models ? { models: entry.models } : {}),
  };
}

/**
 * Wire the proactive-rotation policy to real account state. Shared by a running
 * session (which switches itself in place) and `ccx auto` (which sets the
 * account for the next session), so both make the same decision.
 */
export function buildProactiveDeps(
  context: CliContext,
  options: {
    current: () => string | null;
    requestSwitch: (account: string, reason: string) => void;
    model?: string;
    onError?: (error: Error) => void;
  },
): ProactiveDeps {
  const rotation = context.config.rotation;
  return {
    candidates: () => {
      const capped = cappedNames(loadLedger(context.ctx), Date.now());
      return listAccounts(context.ctx).map((a) => ({
        name: a.name,
        enabled: a.enabled,
        // Credential presence, not a live probe: this runs on a timer and must
        // stay cheap. A dead token simply shows as usage we cannot read, and
        // unknown usage never triggers a switch.
        loggedIn: hasLogin(a.dir),
        capped: capped.has(a.name),
      }));
    },
    current: options.current,
    usage: async () => {
      const snapshot = await refreshUsage(listAccounts(context.ctx), context.ctx);
      const map = new Map<string, UsageLike>();
      for (const [name, entry] of Object.entries(snapshot.accounts)) {
        map.set(name, toUsageLike(entry));
      }
      return map;
    },
    requestSwitch: options.requestSwitch,
    thresholdPercent: rotation.proactivePercent,
    hysteresisPercent: rotation.proactiveHysteresisPercent,
    ...(options.model ? { model: options.model } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  };
}
