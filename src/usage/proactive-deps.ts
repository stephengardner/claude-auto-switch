import { existsSync } from 'node:fs';
import path from 'node:path';
import { listAccounts } from '../accounts/registry.js';
import { loadLedger, cappedNames } from '../ledger/ledger.js';
import { readToken } from '../daemon/token-store.js';
import { refreshUsage } from './usage-store.js';
import type { ProactiveDeps } from './proactive.js';
import type { UsageLike } from './headroom.js';
import type { CliContext } from '../context.js';

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
        loggedIn: existsSync(path.join(a.dir, '.credentials.json')) || readToken(a.dir) !== null,
        capped: capped.has(a.name),
      }));
    },
    current: options.current,
    usage: async () => {
      const snapshot = await refreshUsage(listAccounts(context.ctx), context.ctx);
      const map = new Map<string, UsageLike>();
      for (const [name, entry] of Object.entries(snapshot.accounts)) {
        map.set(name, {
          fiveHour: entry.fiveHour,
          sevenDay: entry.sevenDay,
          ...(entry.models ? { models: entry.models } : {}),
        });
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
