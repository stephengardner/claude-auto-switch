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

/**
 * The Claude Code hooks that let a Claude Desktop conversation move to a
 * terminal by itself.
 *
 * Desktop sessions read `~/.claude/settings.json` (Desktop starts them with
 * `--setting-sources=user,project,local`), so a hook there runs inside them:
 * - `StopFailure` fires when a turn ends on an API error, and carries the error
 *   type, so a usage limit can be told apart from anything else.
 * - `UserPromptSubmit` fires before a message is sent, and can hold it back,
 *   which is how a message is kept from spending usage credits.
 *
 * Each is node running ccx's hook entry, with no shell (see
 * claude/settings-hooks). Every session runs these, not only Desktop's, so the
 * entry decides first and cheaply, and anything that is not Desktop is gone
 * before ccx is loaded.
 */

export type HandoffWhen = 'off' | 'limit' | 'credits';

/** The error types a usage limit ends a turn with. */
export const LIMIT_ERRORS = 'rate_limit|billing_error';
/** Seconds; a hung ccx must not hold Desktop up for Claude's full default. */
const TIMEOUT_SECONDS = 30;

/** This ccx's own, so the hooks always run the ccx that installed them. */
export function thisHookProgram(): HookProgram {
  return {
    node: process.execPath,
    entry: fileURLToPath(new URL('./hook-entry.js', import.meta.url)),
  };
}

type HookEvent = 'limit' | 'prompt';

/** Which of ccx's Desktop hooks this is, if it is one. */
function ourEvent(hook: unknown): HookEvent | null {
  const found = hookEntry(hook);
  if (!found || !/[\\/]desktop[\\/]hook-entry\.js$/.test(found.entry)) return null;
  return found.event === 'limit' || found.event === 'prompt' ? found.event : null;
}

const isOurs = (hook: unknown): boolean => ourEvent(hook) !== null;

/** `settings` with every ccx Desktop hook gone, and any group that left empty. */
export function withoutDesktopHooks(settings: Settings): Settings {
  return withoutHooks(settings, isOurs);
}

/** `settings` with exactly the Desktop hooks `when` calls for. */
export function planDesktopHooks(
  settings: Settings,
  when: HandoffWhen,
  program: HookProgram = thisHookProgram(),
): Settings {
  const base = withoutDesktopHooks(settings);
  if (when === 'off') return base;
  const groups: Array<readonly [string, HookGroup]> = [
    ['StopFailure', { matcher: LIMIT_ERRORS, hooks: [hookCommand(program, 'limit', TIMEOUT_SECONDS)] }],
  ];
  if (when === 'credits') {
    groups.push(['UserPromptSubmit', { hooks: [hookCommand(program, 'prompt', TIMEOUT_SECONDS)] }]);
  }
  return withHookGroups(base, groups);
}

/** Which handoff the hooks in `settings` add up to. */
export function installedHandoff(settings: Settings): HandoffWhen {
  let limit = false;
  let prompt = false;
  eachHook(settings, isOurs, (event, hook) => {
    if (event === 'StopFailure' && ourEvent(hook) === 'limit') limit = true;
    if (event === 'UserPromptSubmit' && ourEvent(hook) === 'prompt') prompt = true;
  });
  if (!limit) return 'off';
  return prompt ? 'credits' : 'limit';
}

/**
 * Why the installed hooks cannot run, or null when they can (or there are
 * none). They name a node and a ccx by path, so a ccx moved or removed since
 * leaves every session on the machine reporting a broken hook.
 */
export function desktopHooksProblem(
  settings: Settings,
  exists: (file: string) => boolean = existsSync,
): string | null {
  let problem: string | null = null;
  eachHook(settings, isOurs, (_event, hook) => {
    if (problem) return;
    const node = hook.command;
    const entry = (hook.args as unknown[])[0] as string;
    if (typeof node !== 'string' || !exists(node))
      problem = `the node they run is gone (${String(node)})`;
    else if (!exists(entry)) problem = `the ccx they run is gone (${entry})`;
  });
  return problem;
}

export type HookWriteResult =
  { ok: true; changed: boolean; file: string } | { ok: false; reason: string; file: string };

/** Make the user's Claude settings hold exactly the hooks `when` calls for. */
export function installDesktopHooks(
  when: HandoffWhen,
  c: PathCtx = {},
  program: HookProgram = thisHookProgram(),
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
  if (!read.ok)
    return { ok: false, reason: `${file} is not valid JSON; fix it and try again`, file };
  const next = planDesktopHooks(read.settings, when, program);
  if (JSON.stringify(next) === JSON.stringify(read.settings))
    return { ok: true, changed: false, file };
  try {
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    return { ok: true, changed: true, file };
  } catch (error) {
    return { ok: false, reason: `could not write ${file}: ${(error as Error).message}`, file };
  }
}

/** What the user's Claude settings currently hand off on, by their hooks. */
export function readInstalledHandoff(c: PathCtx = {}): HandoffWhen {
  try {
    const read = readSettings(settingsPath(c));
    return read.ok ? installedHandoff(read.settings) : 'off';
  } catch {
    return 'off';
  }
}

/**
 * Make the installed hooks match `when`, the handoff the user chose, and point
 * them at this ccx: after an update that moved it, or a reinstall, they would
 * otherwise run nothing. Null when there is nothing to do: none chosen and
 * none installed.
 */
export function refreshDesktopHooks(
  when: HandoffWhen,
  c: PathCtx = {},
  program: HookProgram = thisHookProgram(),
): HookWriteResult | null {
  if (when === 'off' && readInstalledHandoff(c) === 'off') return null;
  return installDesktopHooks(when, c, program);
}

/** desktopHooksProblem, for the hooks in the user's settings. */
export function installedHooksProblem(c: PathCtx = {}): string | null {
  try {
    const read = readSettings(settingsPath(c));
    return read.ok ? desktopHooksProblem(read.settings) : null;
  } catch {
    return null;
  }
}
