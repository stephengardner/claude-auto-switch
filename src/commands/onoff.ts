import { installShim, isShimInstalled, uninstallShim, type ShellKind } from '../shell/install-shim.js';
import { selectShells, shellPlans, type ShellPlan } from '../shell/shells.js';
import { detectEditors } from '../editor/settings.js';
import { enableEditor, disableEditor } from './editor.js';
import { installStatusline, removeStatusline } from '../statusline/settings-install.js';
import { thrownReason } from '../util/thrown-reason.js';
import { installSkill, removeSkill, type SkillOutcome } from '../skill/install-skill.js';
import { installDesktopHooks, readInstalledHandoff, refreshDesktopHooks } from '../desktop/hooks.js';
import { refreshArtifactHooks } from '../artifacts/hooks.js';
import { routingOn } from '../artifacts/route.js';
import type { CliContext } from '../context.js';

export interface ShimOptions {
  /** One file to use instead of every shell's own (--profile). */
  profile?: string;
  /**
   * One shell to set up, even where nothing shows it is used: zsh, bash,
   * powershell or pwsh. With --profile, the shim's flavour: posix or
   * powershell (by default the platform's).
   */
  shell?: string;
  /** Set false to skip setting up installed editors (--no-editor). */
  editor?: boolean;
  /** Set false to leave Claude's status line alone (--no-statusline). */
  statusline?: boolean;
}

export interface ShimDeps {
  /** The shells and their files; worked out from the machine when absent. */
  plans?: ShellPlan[];
}

/** The shim's flavour for a --profile file. */
function profileKind(context: CliContext, shell: string | undefined): ShellKind {
  if (shell === 'powershell' || shell === 'pwsh') return 'powershell';
  if (shell === 'posix' || shell === 'zsh' || shell === 'bash') return 'posix';
  return (context.ctx.platform ?? process.platform) === 'win32' ? 'powershell' : 'posix';
}

/**
 * Put the shim in every file each chosen shell reads, and take any copy out of
 * the files that would load it a second time. `refused` when the shell named
 * is not one ccx knows, before anything is touched.
 */
function installShells(context: CliContext, options: ShimOptions, deps: ShimDeps): 'ok' | 'failed' | 'refused' {
  if (options.profile) {
    const result = installShim(options.profile, profileKind(context, options.shell));
    context.out(
      result === 'installed'
        ? `terminal: transparent \`claude\` installed in ${options.profile}`
        : `terminal: shim already present in ${options.profile}`,
    );
    return 'ok';
  }

  const plans = deps.plans ?? shellPlans(context.ctx);
  const selection = selectShells(plans, options.shell);
  if (!selection.ok) {
    context.out(`terminal: ${selection.reason}`);
    return 'refused';
  }

  let ok = true;
  let changedAny = false;
  for (const plan of selection.chosen) {
    if (plan.blocked) {
      context.out(`terminal: ${plan.label} not set up: ${plan.blocked.detail}`);
      if (plan.blocked.fix) context.out(`  run: ${plan.blocked.fix}, then ccx on`);
      continue;
    }
    const installed: string[] = [];
    const removed: string[] = [];
    let file = '';
    try {
      for (file of plan.files) {
        if (installShim(file, plan.kind) === 'installed') installed.push(file);
      }
      for (file of plan.retired) {
        if (isShimInstalled(file) && uninstallShim(file) === 'removed') removed.push(file);
      }
      context.out(
        installed.length > 0
          ? `terminal: \`claude\` goes through ccx in ${plan.label} now (${plan.files.join(', ')})`
          : `terminal: ${plan.label} already set up (${plan.files.join(', ')})`,
      );
      for (const f of removed) context.out(`  removed the older copy in ${f}, so ${plan.label} loads it once`);
      changedAny ||= installed.length + removed.length > 0;
    } catch (err) {
      ok = false;
      context.out(`terminal: ${plan.label} not set up: could not write ${file}: ${thrownReason(err)}`);
    }
  }
  if (options.shell === undefined) {
    for (const plan of plans.filter((p) => p.state === 'unused')) {
      context.out(`terminal: ${plan.label} left alone, ${plan.why} (ccx on --shell ${plan.id} adds it)`);
    }
  }
  if (changedAny) context.out('  open a new terminal to use it');
  return ok ? 'ok' : 'failed';
}

/** Take the shim out of every file it could be in, or of the one shell or file named. False when refused. */
function removeShells(context: CliContext, options: ShimOptions, deps: ShimDeps): boolean {
  let files: string[];
  if (options.profile) {
    files = [options.profile];
  } else {
    const plans = deps.plans ?? shellPlans(context.ctx);
    const named = options.shell === undefined ? null : selectShells(plans, options.shell);
    if (named && !named.ok) {
      context.out(`terminal: ${named.reason}`);
      return false;
    }
    const chosen = named ? named.chosen : plans;
    files = [...new Set(chosen.flatMap((p) => p.sweep))];
  }
  const removed = files.filter((f) => uninstallShim(f) === 'removed');
  for (const f of removed) context.out(`terminal: shim removed from ${f}`);
  if (removed.length === 0) context.out('terminal: no shim found');
  return true;
}

/**
 * One-command setup: install the transparent `claude` shim in every shell AND,
 * for any editor you have installed, point it at your active ccx account. Pass
 * `editor: false` (--no-editor) to set up the terminal only.
 */
export async function onCommand(
  context: CliContext,
  options: ShimOptions = {},
  deps: ShimDeps = {},
): Promise<number> {
  const shells = installShells(context, options, deps);
  if (shells === 'refused') return 1;

  if (options.statusline !== false) {
    context.out(statuslineMessage(installStatusline(context.ctx)));
  }
  context.out(skillMessage(installSkill(context.ctx)));
  // The Desktop hooks name this ccx by path; after an update that moved it they
  // would run nothing, in every session, so they follow it here, and come back
  // after a `ccx off` as they were chosen.
  const hooks = refreshDesktopHooks(context.config.desktop.handoff, context.ctx);
  if (hooks?.ok && hooks.changed) context.out('claude: Claude Desktop handoff hooks set up');
  else if (hooks && !hooks.ok) {
    context.out(`claude: Claude Desktop handoff hooks not set up: ${hooks.reason}`);
  }

  // The same for the hooks on Claude's Artifact tool, which are only ever
  // there while page routing is on.
  const pageHooks = refreshArtifactHooks(routingOn(context.config.artifacts), context.ctx);
  if (pageHooks?.ok && pageHooks.changed) {
    context.out(
      routingOn(context.config.artifacts)
        ? 'claude: page routing hooks set up'
        : 'claude: page routing is off, so its hooks are removed',
    );
  } else if (pageHooks && !pageHooks.ok) {
    context.out(`claude: page routing hooks not set up: ${pageHooks.reason}`);
  }

  let editorFailed = false;
  if (options.editor !== false) {
    for (const editor of detectEditors(context.ctx)) {
      // One editor failing must not take the whole command down. By this point
      // the shell shim and status line are already installed, and letting the
      // error escape reported a raw stack trace instead of what went wrong,
      // while making a completed setup look like it had done nothing.
      try {
        // The RESULT, not just the absence of a throw: enableEditor reports an
        // expected failure as { ok: false }, so reading only exceptions let a
        // genuine failure exit 0 and report success.
        const result = await enableEditor(context, editor);
        context.out(result.message);
        if (!result.ok) editorFailed = true;
      } catch (err) {
        editorFailed = true;
        context.out(`${editor}: not set up (${thrownReason(err)})`);
      }
    }
  }
  return editorFailed || shells === 'failed' ? 1 : 0;
}

/**
 * Say what happened to the status line, including when nothing did. The shim is
 * invisible on purpose, so this line is how someone knows ccx is on at all.
 */
function statuslineMessage(result: ReturnType<typeof installStatusline>): string {
  switch (result.outcome) {
    case 'installed':
      return 'claude: status line shows your account and remaining room (restart claude to see it)';
    case 'wrapped':
      return 'claude: status line added alongside the one you already had (restart claude to see it)';
    case 'already':
      return 'claude: status line already set up';
    case 'unreadable':
      return `claude: left ${result.file} alone, it is not valid JSON. Fix it and run \`ccx on\` again`;
    default:
      return `claude: could not write ${result.file || 'settings.json'}; run \`ccx statusline --install\` for the snippet`;
  }
}

function skillMessage(outcome: SkillOutcome): string {
  switch (outcome) {
    case 'installed':
      return 'claude: /ccx added, to see every account and swap from inside Claude';
    case 'updated':
      return 'claude: /ccx brought up to date';
    case 'already':
      return 'claude: /ccx already set up';
    case 'user-owned':
      return 'claude: left ~/.claude/skills/ccx alone, it is no longer ccx’s copy';
    default:
      return 'claude: could not add /ccx; ccx swap does the same from a terminal';
  }
}

/**
 * Every outcome gets a line, including the ones where nothing moved. Silence
 * after `ccx off` reads as success, and a status line that is still there is
 * the opposite of that.
 */
function removalMessage(result: ReturnType<typeof removeStatusline>): string {
  switch (result.outcome) {
    case 'removed':
      return 'claude: status line removed';
    case 'restored':
      return 'claude: your previous status line is back';
    case 'untouched':
      return 'claude: status line is not ccx’s, left as it is';
    case 'unreadable':
      return `claude: left ${result.file} alone, it is not valid JSON`;
    default:
      return `claude: could not write ${result.file || 'settings.json'}; remove the statusLine entry by hand`;
  }
}

/** Remove the shim from the shell, and ccx from any installed editors. */
export function offCommand(context: CliContext, options: ShimOptions = {}, deps: ShimDeps = {}): number {
  if (!removeShells(context, options, deps)) return 1;

  if (options.statusline !== false) {
    context.out(removalMessage(removeStatusline(context.ctx)));
  }
  const skill = removeSkill(context.ctx);
  context.out(
    skill === 'removed'
      ? 'claude: /ccx removed'
      : skill === 'user-owned'
        ? 'claude: left ~/.claude/skills/ccx alone, it is no longer ccx’s copy'
        : skill === 'not-present'
          ? 'claude: no /ccx to remove'
          : 'claude: could not remove ~/.claude/skills/ccx; delete it by hand',
  );
  // Everything ccx put into ~/.claude goes, so nothing there runs a ccx that
  // may be uninstalled next. The choice is kept: `ccx on` puts them back.
  if (readInstalledHandoff(context.ctx) !== 'off') {
    const hooks = installDesktopHooks('off', context.ctx);
    context.out(
      hooks.ok
        ? 'claude: Claude Desktop handoff hooks removed (ccx on puts them back)'
        : `claude: could not remove the Claude Desktop handoff hooks: ${hooks.reason}`,
    );
  }

  const pageHooks = refreshArtifactHooks(false, context.ctx);
  if (pageHooks) {
    context.out(
      pageHooks.ok
        ? 'claude: page routing hooks removed (ccx on puts them back)'
        : `claude: could not remove the page routing hooks: ${pageHooks.reason}`,
    );
  }

  if (options.editor !== false) {
    for (const editor of detectEditors(context.ctx)) {
      context.out(disableEditor(context, editor).message);
    }
  }
  return 0;
}
