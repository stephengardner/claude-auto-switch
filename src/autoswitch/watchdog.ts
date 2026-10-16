import path from 'node:path';
import { z } from 'zod';
import type { PathCtx } from '../config/paths.js';
import { readJsonFile, writeJsonFile } from '../util/fs-json.js';
import { MINUTE } from './decide.js';
import type { WatchdogEvent } from './notify.js';
import { watchDir } from './state.js';

/**
 * A second machine keeping the watcher alive.
 *
 * The watcher's own service restarts it when it crashes. That covers a
 * process that dies, and nothing else: not a service somebody stopped, a unit
 * that failed to start after a reboot, or a machine that fell off the
 * network. So another machine asks the watcher's machine, once a minute, when
 * its last pass started. When that is over three minutes ago with no pass
 * running, it runs a pass there itself, which keeps accounts moving at once,
 * and asks for the service to be started again.
 *
 * Everything is injected, so the rules run against a made-up machine.
 */

/** A pass starts every thirty seconds; three minutes without one is not a slow pass. */
const STALE_MS = 3 * MINUTE;
/** The restart is asked for once per ten minutes, however many passes find the watcher down. */
const RESTART_EVERY_MS = 10 * MINUTE;
/** How long the watcher's machine goes unanswered before anybody is told. */
const UNREACHABLE_TELL_MS = 5 * MINUTE;

/** What `ccx autoswitch facts` prints on the watcher's machine. */
export interface WatcherFacts {
  /** When its service last started a pass, or null when it never has. */
  beatAt: number | null;
  /** A pass holds the lock right now. */
  passRunning: boolean;
  /** That machine's own clock, so two machines that disagree about the time still agree about an age. */
  now: number;
}

/** Read what `ccx autoswitch facts` printed; null for anything else. */
export function parseFacts(stdout: string): WatcherFacts | null {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .pop();
  if (!line) return null;
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    if (typeof raw.now !== 'number' || typeof raw.passRunning !== 'boolean') return null;
    return {
      beatAt: typeof raw.beatAt === 'number' ? raw.beatAt : null,
      passRunning: raw.passRunning,
      now: raw.now,
    };
  } catch {
    return null;
  }
}

const WatchdogStateSchema = z.object({
  unreachableSince: z.number().nullable().default(null),
  unreachableTold: z.boolean().default(false),
  downSince: z.number().nullable().default(null),
  downTold: z.boolean().default(false),
  restartAt: z.number().default(0),
});

export type WatchdogState = z.infer<typeof WatchdogStateSchema>;

/** One file per watched host, so one machine can look after several. */
function watchdogStatePath(host: string, c: PathCtx): string {
  return path.join(watchDir(c), `watchdog-${host.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

export function loadWatchdogState(host: string, c: PathCtx = {}): WatchdogState {
  try {
    return readJsonFile(watchdogStatePath(host, c), WatchdogStateSchema) ?? WatchdogStateSchema.parse({});
  } catch {
    return WatchdogStateSchema.parse({});
  }
}

export function saveWatchdogState(host: string, state: WatchdogState, c: PathCtx = {}): void {
  try {
    writeJsonFile(watchdogStatePath(host, c), state);
  } catch {
    /* the next pass starts from what it finds */
  }
}

export interface WatchdogDeps {
  host: string;
  now: () => number;
  /** Ask the watcher's machine how it is; null when it did not answer. */
  facts: () => Promise<WatcherFacts | null>;
  /** Run one pass there, and say how it went: in a word, never in the text it printed. */
  runPass: () => Promise<string>;
  /** Ask for its service to be started again; null when no way to was given. */
  restart: (() => Promise<boolean>) | null;
  loadState: () => WatchdogState;
  saveState: (state: WatchdogState) => void;
  log: (line: string) => void;
  announce: (event: WatchdogEvent) => Promise<void>;
}

export interface WatchdogReport {
  host: string;
  state: 'healthy' | 'unreachable' | 'down';
  detail: string;
  /** How the pass run from here went, when one was run. */
  ranPass?: string;
  restarted?: boolean;
}

async function quietly<T>(work: () => Promise<T>, otherwise: T): Promise<T> {
  try {
    return await work();
  } catch {
    return otherwise;
  }
}

export async function watchdogPass(deps: WatchdogDeps): Promise<WatchdogReport> {
  const now = deps.now();
  const state = deps.loadState();
  const done = (report: WatchdogReport): WatchdogReport => {
    deps.saveState(state);
    return report;
  };

  const facts = await quietly(deps.facts, null);
  if (!facts) {
    state.unreachableSince ??= now;
    const forMs = now - state.unreachableSince;
    if (forMs >= UNREACHABLE_TELL_MS && !state.unreachableTold) {
      // Nothing can be switched from here: the logins live on that machine.
      // What this machine can do is make sure somebody knows.
      deps.log(`${deps.host} has not answered for ${Math.round(forMs / MINUTE)} min`);
      await quietly(() => deps.announce({ type: 'watcher-unreachable', forMs }), undefined);
      state.unreachableTold = true;
    }
    return done({ host: deps.host, state: 'unreachable', detail: `no answer for ${Math.round(forMs / 1000)}s` });
  }
  if (state.unreachableSince !== null) {
    deps.log(`${deps.host} answers again`);
    state.unreachableSince = null;
    state.unreachableTold = false;
  }

  // Never in the middle of a pass: a pass that is running is the watcher working.
  const stale = !facts.passRunning && (facts.beatAt === null || facts.now - facts.beatAt > STALE_MS);
  if (!stale) {
    if (state.downSince !== null) deps.log(`the watcher on ${deps.host} runs again`);
    state.downSince = null;
    state.downTold = false;
    const age = facts.beatAt === null ? 'a pass is running' : `last pass ${Math.round((facts.now - facts.beatAt) / 1000)}s ago`;
    return done({ host: deps.host, state: 'healthy', detail: age });
  }

  state.downSince ??= now;
  // The pass first: it is what keeps accounts moving while the service is down.
  const ranPass = await quietly(deps.runPass, 'the pass could not be run');
  let restarted: boolean | undefined;
  if (deps.restart && now - state.restartAt >= RESTART_EVERY_MS) {
    state.restartAt = now;
    restarted = await quietly(deps.restart, false);
  }
  if (!state.downTold) {
    deps.log(
      `the watcher on ${deps.host} was not running; ran a pass there` +
        (restarted === undefined ? '' : restarted ? ' and asked for it to be started again' : '; asking for it to be started again failed'),
    );
    await quietly(() => deps.announce({ type: 'watcher-down' }), undefined);
    state.downTold = true;
  }
  return done({
    host: deps.host,
    state: 'down',
    detail: facts.beatAt === null ? 'its service has never run a pass' : `no pass for ${Math.round((facts.now - facts.beatAt) / 1000)}s`,
    ranPass,
    ...(restarted !== undefined ? { restarted } : {}),
  });
}
