import fs from 'node:fs';
import { decideRotation, type RotateDecision } from './rotate-policy.js';
import type { UsageSnapshot } from './usage.js';

export interface DaemonProfile {
  name: string;
  dir: string;
}

export interface DaemonDeps {
  profiles: () => DaemonProfile[];
  getActive: () => string;
  setActive: (name: string) => void;
  readUsage: (dir: string) => UsageSnapshot | null;
  flip: (targetDir: string) => void;
  threshold: number;
  log: (message: string) => void;
  now: () => number;
}

export interface TickResult {
  rotated: boolean;
  decision: RotateDecision;
}

/**
 * One evaluation: read every account's usage, decide, and (if the active
 * account is capped and a healthy one exists) flip the junction and persist the
 * new active account. Pure given its injected deps, so it is fully testable.
 */
export function tick(deps: DaemonDeps): TickResult {
  const profiles = deps.profiles();
  const active = deps.getActive();
  const accounts = profiles.map((p) => ({ name: p.name, usage: deps.readUsage(p.dir) }));
  const decision = decideRotation({ active, accounts, threshold: deps.threshold });

  if (decision.shouldRotate && decision.target) {
    const target = profiles.find((p) => p.name === decision.target);
    if (target) {
      deps.flip(target.dir);
      deps.setActive(target.name);
      deps.log(`rotated ${active} -> ${target.name}: ${decision.reason}`);
      return { rotated: true, decision };
    }
  }
  return { rotated: false, decision };
}

export interface RunDaemonOptions {
  /** The active junction dir, where usage-cache.json appears for the active account. */
  watchDir: string;
  intervalMs: number;
  signal: AbortSignal;
}

/** Run the watch-and-rotate loop until aborted. Thin wrapper over tick(). */
export async function runDaemon(deps: DaemonDeps, options: RunDaemonOptions): Promise<void> {
  const evaluate = (): void => {
    try {
      tick(deps);
    } catch (err) {
      deps.log(`tick error: ${(err as Error).message}`);
    }
  };

  evaluate();

  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(options.watchDir, (_event, filename) => {
      if (!filename || filename.toString().startsWith('usage-cache')) evaluate();
    });
  } catch {
    // fs.watch is best-effort; the interval below still covers us.
  }

  const timer = setInterval(evaluate, options.intervalMs);

  await new Promise<void>((resolve) => {
    options.signal.addEventListener('abort', () => {
      clearInterval(timer);
      watcher?.close();
      resolve();
    });
  });
}
