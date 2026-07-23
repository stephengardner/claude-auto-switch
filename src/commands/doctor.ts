import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { configHome, profilesDir } from '../config/paths.js';
import { detectEditors } from '../editor/settings.js';
import { readEditorEnvVar } from '../editor/install.js';
import { getClaude, type CliContext } from '../context.js';
import type { ClaudeInvoker } from '../invoker.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorDeps {
  /** Tracked file list (defaults to `git ls-files`); injected in tests. */
  gitTrackedFiles?: () => string[];
  /** Claude resolver (defaults to getClaude); injected in tests. */
  resolveClaude?: () => ClaudeInvoker;
  /** Browser debug-port reachability probe; injected in tests. */
  checkBrowserPort?: (port: number) => Promise<boolean>;
}

/** Files that must never be committed. */
const SECRET_PATTERNS = [
  /(^|[\\/])\.credentials\.json$/,
  /(^|[\\/])accounts\.json$/,
  /(^|[\\/])ledger\.json$/,
  /(^|[\\/])oauth-token$/,
  /(^|[\\/])session-debug\.log$/,
  /(^|[\\/])last-setup-token-output\.txt$/,
  /(^|[\\/])profiles[\\/]/,
];

/** Fail if any credential or profile file is tracked in git. */
export function auditGitSafety(trackedFiles: string[]): DoctorCheck {
  const dangerous = trackedFiles.filter((f) => SECRET_PATTERNS.some((re) => re.test(f)));
  return {
    name: 'git-safety',
    ok: dangerous.length === 0,
    detail:
      dangerous.length === 0
        ? 'no credential or profile files are tracked in git'
        : `secrets tracked in git: ${dangerous.join(', ')}`,
  };
}

function auditConfig(context: CliContext): DoctorCheck {
  const home = configHome(context.ctx);
  const profiles = profilesDir(context.config, context.ctx);
  return {
    name: 'config',
    ok: true,
    detail: `config home ${home}; profiles ${profiles}${existsSync(home) ? '' : ' (not created yet)'}`,
  };
}

function auditRealClaude(context: CliContext, deps: DoctorDeps): DoctorCheck {
  try {
    const claude = (deps.resolveClaude ?? (() => getClaude(context)))();
    return { name: 'real-claude', ok: true, detail: `resolved to ${claude.bin}` };
  } catch (err) {
    return { name: 'real-claude', ok: false, detail: (err as Error).message };
  }
}

/** Informational: is Chrome listening on the debug port (needed only for auto-login)? */
async function auditBrowserPort(context: CliContext, deps: DoctorDeps): Promise<DoctorCheck> {
  const port = context.config.browser.debugPort;
  const reachable = await (deps.checkBrowserPort ?? defaultCheckBrowserPort)(port);
  return {
    name: 'browser-debug-port',
    ok: true,
    detail: reachable
      ? `Chrome DevTools reachable on ${port}`
      : `no Chrome on debug port ${port} (needed only for auto-login; start Chrome with --remote-debugging-port=${port})`,
  };
}

function defaultCheckBrowserPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function defaultTrackedFiles(): string[] {
  try {
    return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/** Informational: report which installed editors are pointed at ccx. */
export function auditEditor(context: CliContext): DoctorCheck {
  const editors = detectEditors(context.ctx);
  if (editors.length === 0) {
    return { name: 'editor', ok: true, detail: 'no Cursor/VS Code detected' };
  }
  const parts = editors.map((e) => {
    const v = readEditorEnvVar(e, 'CLAUDE_CONFIG_DIR', context.ctx);
    return `${e} ${v ? 'set up (ccx on)' : 'not set up (run: ccx on)'}`;
  });
  return { name: 'editor', ok: true, detail: parts.join('; ') };
}

export async function runDoctor(
  context: CliContext,
  deps: DoctorDeps = {},
): Promise<{ checks: DoctorCheck[]; ok: boolean }> {
  const trackedFiles = (deps.gitTrackedFiles ?? defaultTrackedFiles)();
  const checks = [
    auditConfig(context),
    auditGitSafety(trackedFiles),
    auditRealClaude(context, deps),
    auditEditor(context),
    await auditBrowserPort(context, deps),
  ];
  return { checks, ok: checks.every((c) => c.ok) };
}

/** Print the doctor report and return 0 when all checks pass, 1 otherwise. */
export async function doctorCommand(context: CliContext, deps: DoctorDeps = {}): Promise<number> {
  const { checks, ok } = await runDoctor(context, deps);
  for (const check of checks) {
    context.out(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.name}: ${check.detail}`);
  }
  context.out(ok ? 'doctor: all checks passed' : 'doctor: some checks FAILED');
  return ok ? 0 : 1;
}
