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
 * Every session reads that file, not only Desktop's, so each command starts
 * with a shell test that lets anything else skip ccx entirely. Claude runs hook
 * commands through bash on every platform, Git Bash on Windows (measured), and
 * the test is plain POSIX. It is written so a non-Desktop session ends on a
 * successful test, never masking ccx's own exit code, which is how a held
 * message is reported.
 */

export type HandoffWhen = 'off' | 'limit' | 'credits';

const GUARD = '[ "$CLAUDE_CODE_ENTRYPOINT" != claude-desktop ] ||';
export const LIMIT_HOOK = `${GUARD} ccx desktop-hook limit`;
export const PROMPT_HOOK = `${GUARD} ccx desktop-hook prompt`;
/** The error types a usage limit ends a turn with. */
export const LIMIT_ERRORS = 'rate_limit|billing_error';
/** Seconds; a hung ccx must not hold Desktop up for Claude's full default. */
const TIMEOUT_SECONDS = 30;

/** Anchored on ccx's own command, so a hook somebody else wrote is never touched. */
const OURS = /\bccx desktop-hook (?:limit|prompt)\b/;

type Settings = Record<string, unknown>;
type Group = { matcher?: string; hooks?: unknown[]; [key: string]: unknown };

function isOurs(hook: unknown): boolean {
  if (typeof hook !== 'object' || hook === null) return false;
  const command = (hook as { command?: unknown }).command;
  return typeof command === 'string' && OURS.test(command);
}

/** `settings` with every ccx Desktop hook gone, and any group that left empty. */
export function withoutDesktopHooks(settings: Settings): Settings {
  const hooks = settings.hooks;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return settings;
  const kept: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      kept[event] = groups;
      continue;
    }
    const left = groups
      .map((group) => {
        if (typeof group !== 'object' || group === null) return group;
        const g = group as Group;
        if (!Array.isArray(g.hooks)) return g;
        return { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) };
      })
      // Only a group ccx emptied is dropped; one that came empty is the user's.
      .filter((group, i) => {
        const before = groups[i] as Group;
        const after = group as Group;
        return !(
          Array.isArray(before?.hooks) &&
          before.hooks.length > 0 &&
          after.hooks?.length === 0
        );
      });
    if (left.length > 0) kept[event] = left;
  }
  const rest = { ...settings };
  if (Object.keys(kept).length === 0) delete rest.hooks;
  else rest.hooks = kept;
  return rest;
}

/** `settings` with exactly the Desktop hooks `when` calls for. */
export function planDesktopHooks(settings: Settings, when: HandoffWhen): Settings {
  const base = withoutDesktopHooks(settings);
  if (when === 'off') return base;
  const hooks: Record<string, unknown> = {
    ...((typeof base.hooks === 'object' && base.hooks !== null ? base.hooks : {}) as Record<
      string,
      unknown
    >),
  };
  const add = (event: string, group: Group): void => {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    hooks[event] = [...existing, group];
  };
  add('StopFailure', {
    matcher: LIMIT_ERRORS,
    hooks: [{ type: 'command', command: LIMIT_HOOK, timeout: TIMEOUT_SECONDS }],
  });
  if (when === 'credits') {
    add('UserPromptSubmit', {
      hooks: [{ type: 'command', command: PROMPT_HOOK, timeout: TIMEOUT_SECONDS }],
    });
  }
  return { ...base, hooks };
}

/** Which handoff the hooks in `settings` add up to. */
export function installedHandoff(settings: Settings): HandoffWhen {
  const hooks = settings.hooks;
  if (typeof hooks !== 'object' || hooks === null) return 'off';
  const has = (event: string, command: string): boolean => {
    const groups = (hooks as Record<string, unknown>)[event];
    return (
      Array.isArray(groups) &&
      groups.some(
        (g) =>
          Array.isArray((g as Group)?.hooks) &&
          ((g as Group).hooks as unknown[]).some(
            (h) => (h as { command?: unknown })?.command === command,
          ),
      )
    );
  };
  if (!has('StopFailure', LIMIT_HOOK)) return 'off';
  return has('UserPromptSubmit', PROMPT_HOOK) ? 'credits' : 'limit';
}

export type HookWriteResult =
  { ok: true; changed: boolean; file: string } | { ok: false; reason: string; file: string };

/** Make the user's Claude settings hold exactly the hooks `when` calls for. */
export function installDesktopHooks(when: HandoffWhen, c: PathCtx = {}): HookWriteResult {
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
  const next = planDesktopHooks(read.settings, when);
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
