/**
 * The hooks ccx keeps in the user's Claude settings, among the user's own.
 *
 * Every hook ccx installs is a program and its arguments, run with no shell
 * (Claude's "exec form"): node, running one of ccx's hook entries. A shell
 * command would be read by whichever shell Claude picks, Git Bash on Windows
 * when there is one and PowerShell when there is not, and no single test reads
 * the same in both. ccx knows its own hooks by the entry they run, so a hook
 * somebody else wrote is never touched, and one left by a ccx installed
 * somewhere else is still recognised and replaced.
 */

export type Settings = Record<string, unknown>;
export type HookGroup = { matcher?: string; hooks?: unknown[]; [key: string]: unknown };

/** What Claude runs for a ccx hook: a node, and one of ccx's hook entries. */
export interface HookProgram {
  node: string;
  entry: string;
}

/** One hook in exec form: `program` with `event` as its argument. */
export function hookCommand(program: HookProgram, event: string, timeoutSeconds: number): Record<string, unknown> {
  return {
    type: 'command',
    command: program.node,
    args: [program.entry, event],
    timeout: timeoutSeconds,
  };
}

/** The entry a hook runs and the argument after it, when it has that shape. */
export function hookEntry(hook: unknown): { entry: string; event: unknown } | null {
  if (typeof hook !== 'object' || hook === null) return null;
  const args = (hook as { args?: unknown }).args;
  if (!Array.isArray(args) || typeof args[0] !== 'string') return null;
  return { entry: args[0], event: args[1] };
}

function hooksOf(settings: Settings): Record<string, unknown> | null {
  const hooks = settings.hooks;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return null;
  return hooks as Record<string, unknown>;
}

/** Visit each hook in `settings` that `isOurs` picks out, with the event it is under. */
export function eachHook(
  settings: Settings,
  isOurs: (hook: unknown) => boolean,
  visit: (event: string, hook: Record<string, unknown>) => void,
): void {
  const hooks = hooksOf(settings);
  if (!hooks) return;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const list = (group as HookGroup)?.hooks;
      if (!Array.isArray(list)) continue;
      for (const hook of list) {
        if (isOurs(hook)) visit(event, hook as Record<string, unknown>);
      }
    }
  }
}

/** `settings` without the hooks `isOurs` picks out, and any group that left empty. */
export function withoutHooks(settings: Settings, isOurs: (hook: unknown) => boolean): Settings {
  const hooks = hooksOf(settings);
  if (!hooks) return settings;
  const kept: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      kept[event] = groups;
      continue;
    }
    const left = groups
      .map((group) => {
        if (typeof group !== 'object' || group === null) return group;
        const g = group as HookGroup;
        if (!Array.isArray(g.hooks)) return g;
        return { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) };
      })
      // Only a group ccx emptied is dropped; one that came empty is the user's.
      .filter((group, i) => {
        const before = groups[i] as HookGroup;
        const after = group as HookGroup;
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

/** `settings` with each of `groups` added after what its event already holds. */
export function withHookGroups(settings: Settings, groups: ReadonlyArray<readonly [string, HookGroup]>): Settings {
  if (groups.length === 0) return settings;
  const hooks: Record<string, unknown> = { ...(hooksOf(settings) ?? {}) };
  for (const [event, group] of groups) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    hooks[event] = [...existing, group];
  }
  return { ...settings, hooks };
}
