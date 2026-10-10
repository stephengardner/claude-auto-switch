import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  eachHook,
  hookCommand,
  hookEntry,
  withHookGroups,
  withoutHooks,
  type HookGroup,
  type HookProgram,
  type Settings,
} from '../claude/settings-hooks.js';
import { readSettings, settingsPath } from '../statusline/settings-install.js';
import { writeFileAtomic } from '../util/atomic-write.js';
import type { PathCtx } from '../config/paths.js';
import type { HookWriteResult } from '../desktop/hooks.js';

/**
 * The Claude Code hooks that let ccx decide which account a page is published
 * as: around every call of Claude's Artifact tool, before it (where the
 * session can be moved, or the call refused), after it, and after it fails.
 *
 * They are in the user's settings only while page routing is on. Every Claude
 * on the machine runs them, so the entry leaves at once in anything that is
 * not a ccx session (see hook-entry).
 */

/** The tool they are on, as Claude's hook matcher names it. */
export const ARTIFACT_TOOL = 'Artifact';

/**
 * Seconds. Each is longer than the longest the entry waits by itself (hook.ts),
 * so it always answers before Claude gives up on it: a hook Claude gave up on
 * does not stop the call, and the page would go out on whatever account the
 * session happened to be on.
 */
const TIMEOUT_SECONDS = { pre: 45, post: 30, fail: 30 } as const;

const EVENTS = [
  ['PreToolUse', 'pre'],
  ['PostToolUse', 'post'],
  ['PostToolUseFailure', 'fail'],
] as const;

export type ArtifactHookEvent = (typeof EVENTS)[number][1];

/** This ccx's own, so the hooks always run the ccx that installed them. */
export function thisArtifactHookProgram(): HookProgram {
  return {
    node: process.execPath,
    entry: fileURLToPath(new URL('./hook-entry.js', import.meta.url)),
  };
}

function ourEvent(hook: unknown): ArtifactHookEvent | null {
  const found = hookEntry(hook);
  if (!found || !/[\\/]artifacts[\\/]hook-entry\.js$/.test(found.entry)) return null;
  return EVENTS.find(([, word]) => word === found.event)?.[1] ?? null;
}

const isOurs = (hook: unknown): boolean => ourEvent(hook) !== null;

/** `settings` with every ccx Artifact hook gone, and any group that left empty. */
export function withoutArtifactHooks(settings: Settings): Settings {
  return withoutHooks(settings, isOurs);
}

/** `settings` with the Artifact hooks when routing is `on`, and without them when it is not. */
export function planArtifactHooks(
  settings: Settings,
  on: boolean,
  program: HookProgram = thisArtifactHookProgram(),
): Settings {
  const base = withoutArtifactHooks(settings);
  if (!on) return base;
  return withHookGroups(
    base,
    EVENTS.map(([event, word]): readonly [string, HookGroup] => [
      event,
      { matcher: ARTIFACT_TOOL, hooks: [hookCommand(program, word, TIMEOUT_SECONDS[word])] },
    ]),
  );
}

/** Whether all three hooks are there. Fewer is a set somebody half removed. */
export function artifactHooksInstalled(settings: Settings): boolean {
  const found = new Set<string>();
  eachHook(settings, isOurs, (event, hook) => {
    const word = ourEvent(hook);
    if (EVENTS.some(([name, w]) => name === event && w === word)) found.add(event);
  });
  return found.size === EVENTS.length;
}

/** Whether any of them is there at all. */
function anyInstalled(settings: Settings): boolean {
  let any = false;
  eachHook(settings, isOurs, () => {
    any = true;
  });
  return any;
}

/**
 * Why the installed hooks cannot run, or null when they can (or there are
 * none). They name a node and a ccx by path, so a ccx moved or removed since
 * leaves every session on the machine reporting a broken hook.
 */
export function artifactHooksProblem(
  settings: Settings,
  exists: (file: string) => boolean = existsSync,
): string | null {
  let problem: string | null = null;
  eachHook(settings, isOurs, (_event, hook) => {
    if (problem) return;
    const node = hook.command;
    const entry = (hook.args as unknown[])[0] as string;
    if (typeof node !== 'string' || !exists(node)) problem = `the node they run is gone (${String(node)})`;
    else if (!exists(entry)) problem = `the ccx they run is gone (${entry})`;
  });
  return problem;
}

/** Make the user's Claude settings hold the Artifact hooks, or not hold them. */
export function installArtifactHooks(
  on: boolean,
  c: PathCtx = {},
  program: HookProgram = thisArtifactHookProgram(),
): HookWriteResult {
  let file: string;
  try {
    file = settingsPath(c);
  } catch {
    return { ok: false, reason: 'could not find your Claude settings folder', file: '' };
  }
  const read = readSettings(file);
  // A file that does not parse is never rewritten: it holds the user's hooks
  // and permissions, and "fixing" it here would destroy them.
  if (!read.ok) return { ok: false, reason: `${file} is not valid JSON; fix it and try again`, file };
  const next = planArtifactHooks(read.settings, on, program);
  if (JSON.stringify(next) === JSON.stringify(read.settings)) return { ok: true, changed: false, file };
  try {
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    return { ok: true, changed: true, file };
  } catch (error) {
    return { ok: false, reason: `could not write ${file}: ${(error as Error).message}`, file };
  }
}

function readUserSettings(c: PathCtx): Settings | null {
  try {
    const read = readSettings(settingsPath(c));
    return read.ok ? read.settings : null;
  } catch {
    return null;
  }
}

/** Whether the user's Claude settings hold all three hooks now. */
export function readArtifactHooksInstalled(c: PathCtx = {}): boolean {
  const settings = readUserSettings(c);
  return settings !== null && artifactHooksInstalled(settings);
}

/**
 * Make the installed hooks match the choice, and point them at this ccx: after
 * an update that moved it they would otherwise run nothing. Null when there is
 * nothing to do and nothing is read twice or written: routing off and no hook
 * of ccx's in the file.
 */
export function refreshArtifactHooks(
  on: boolean,
  c: PathCtx = {},
  program: HookProgram = thisArtifactHookProgram(),
): HookWriteResult | null {
  if (!on) {
    const settings = readUserSettings(c);
    if (settings === null || !anyInstalled(settings)) return null;
  }
  return installArtifactHooks(on, c, program);
}

/** artifactHooksProblem, for the hooks in the user's settings. */
export function installedArtifactHooksProblem(c: PathCtx = {}): string | null {
  const settings = readUserSettings(c);
  return settings === null ? null : artifactHooksProblem(settings);
}
