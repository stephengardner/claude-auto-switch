import { getActive, setActive } from '../state/active.js';
import { requestMoves } from '../state/switch-request.js';
import { moveEditorToActive } from '../editor/folder.js';
import { proactiveTick, type TickResult } from '../usage/proactive.js';
import { DEFAULT_PROACTIVE_PERCENT } from './proactive-config.js';
import { buildProactiveDeps } from '../usage/proactive-deps.js';
import { appendEvent } from '../events/log.js';
import { configHome } from '../config/paths.js';
import { liveLeases } from '../session/lease.js';
import { numberSessions } from '../dashboard/session-choice.js';
import { handOver, holdsNothing, newerToFollow } from '../update/follow.js';
import type { CliContext } from '../context.js';

export interface AutoOptions {
  /** Run a single check and exit (for cron / scripts). */
  once?: boolean;
  /** Emit one JSON object per check instead of prose. */
  json?: boolean;
  /** Decide using one model's weekly window (e.g. "Fable"). */
  model?: string;
  /** Seconds between checks in the looping form. */
  interval?: string;
  /** Report what would happen without switching anything. */
  dryRun?: boolean;
  /** Override the configured "nearly out" percent for this run. */
  threshold?: string;
}

/** Stable exit codes so scripts can branch without parsing output. */
export const AUTO_EXIT = {
  switched: 0,
  error: 1,
  nothingToDo: 2,
  blocked: 3,
} as const;

function exitCodeFor(result: TickResult): number {
  if (result.outcome === 'switched') return AUTO_EXIT.switched;
  if (result.outcome === 'error') return AUTO_EXIT.error;
  if (result.outcome === 'disabled') return AUTO_EXIT.blocked;
  return AUTO_EXIT.nothingToDo;
}

/**
 * Keep the active account ahead of its limits. Each check reads real usage and,
 * when the account in use is nearly out, moves to the one with the most room.
 * `--once` makes it a cron-friendly single check with a documented exit code.
 */
export async function autoCommand(context: CliContext, options: AutoOptions = {}): Promise<number> {
  const home = configHome(context.ctx);
  const emit = (result: TickResult): void => {
    if (options.json || context.json) {
      context.out(
        JSON.stringify({
          schemaVersion: 1,
          event: result.outcome,
          ...(result.account ? { account: result.account } : {}),
          reason: result.reason,
        }),
      );
      return;
    }
    if (result.outcome === 'switched') context.out(`switched to ${result.account}: ${result.reason}`);
    else if (result.outcome === 'disabled') context.out('proactive rotation is off (set rotation.proactivePercent)');
    else context.out(result.reason);
  };

  const deps = buildProactiveDeps(context, {
    current: () => getActive(context.ctx),
    requestSwitch: (account, reason) => {
      if (options.dryRun) return;
      const leaving = getActive(context.ctx);
      setActive(account, context.ctx);
      void moveEditorToActive(context);
      // Each running session on the account being left is asked by a request
      // of its own and moves in place. A shared request was taken by whichever
      // session looked first, which need not be one on that account at all.
      // With none running, this only decides where the next session starts.
      const onLeaving = numberSessions(liveLeases(context.ctx)).filter((s) => s.account === leaving);
      requestMoves(account, onLeaving, 'seamless', context.ctx);
      appendEvent(home, `proactive switch to ${account} (${reason})`, Date.now());
    },
    ...(options.model ? { model: options.model } : {}),
  });
  // Running this command IS the opt-in, so it works even when the always-on
  // watcher is switched off; `ccx proactive on` is what enables that.
  if (!deps.thresholdPercent) deps.thresholdPercent = DEFAULT_PROACTIVE_PERCENT;
  const override = Number(options.threshold);
  if (Number.isFinite(override) && override >= 0 && override <= 100) {
    deps.thresholdPercent = override;
  }

  if (options.once) {
    const result = await proactiveTick(deps);
    emit(result);
    return exitCodeFor(result);
  }

  // Looping form: a foreground watcher (Ctrl-C to stop).
  const intervalMs = Math.max(30, Number(options.interval) || context.config.rotation.usageCheckSeconds) * 1000;
  const state: { lastSwitchAt?: number } = {};
  const json = options.json || context.json;
  if (!json) {
    context.out(`watching usage every ${Math.round(intervalMs / 1000)}s (Ctrl-C to stop)`);
  }
  // Not unref'd: this watcher is meant to keep running until interrupted.
  const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));
  for (;;) {
    // Between checks, nothing is under way but a move of the editor a switch
    // started, which holds its lock while it writes: no check runs until the
    // newer ccx has taken over.
    const newer = newerToFollow(context);
    if (newer) {
      if (holdsNothing()) {
        if (!json) context.out(`ccx ${newer.version} is installed; carrying on in it`);
        return handOver(context, newer, autoArgs(context, options), 'ccx auto');
      }
      await sleep(1_000);
      continue;
    }
    emit(await proactiveTick(deps, state));
    await sleep(intervalMs);
  }
}

/** The command line that runs this watcher again. */
function autoArgs(context: CliContext, options: AutoOptions): string[] {
  return [
    ...(context.quiet ? ['--quiet'] : []),
    'auto',
    ...(options.json || context.json ? ['--json'] : []),
    ...(options.model !== undefined ? ['--model', options.model] : []),
    ...(options.interval !== undefined ? ['--interval', options.interval] : []),
    ...(options.dryRun ? ['--dry-run'] : []),
    ...(options.threshold !== undefined ? ['--threshold', options.threshold] : []),
  ];
}
