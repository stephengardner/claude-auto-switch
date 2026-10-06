import { listAccounts } from '../accounts/registry.js';
import { loadLedger, cappedNames } from '../ledger/ledger.js';
import { hasWorkingLogin } from '../accounts/account-login.js';
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
    /** Re-read the settings before each decision (a running session passes its own). */
    refresh?: () => void;
  },
): ProactiveDeps {
  // Set only by a caller that overrides the setting (`ccx auto --threshold`).
  let threshold: number | undefined;
  let hysteresis: number | undefined;
  return {
    ...(options.refresh ? { refresh: options.refresh } : {}),
    // Read at each decision rather than captured here: a refresh replaces
    // the rotation settings, and a captured copy would keep the old percent
    // for as long as the session ran.
    get thresholdPercent() {
      return threshold ?? context.config.rotation.proactivePercent;
    },
    set thresholdPercent(value: number) {
      threshold = value;
    },
    get hysteresisPercent() {
      return hysteresis ?? context.config.rotation.proactiveHysteresisPercent;
    },
    set hysteresisPercent(value: number) {
      hysteresis = value;
    },
    candidates: () => {
      const capped = cappedNames(loadLedger(context.ctx), Date.now());
      return listAccounts(context.ctx).map((a) => ({
        name: a.name,
        enabled: a.enabled,
        // Credential presence, not a live probe: this runs on a timer and must
        // stay cheap. A dead token simply shows as usage we cannot read, and
        // unknown usage never triggers a switch.
        loggedIn: hasWorkingLogin(a.dir, context.ctx),
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
    ...(options.model ? { model: options.model } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  };
}
