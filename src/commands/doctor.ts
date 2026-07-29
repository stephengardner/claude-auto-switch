import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { configHome, profilesDir } from '../config/paths.js';
import { detectEditors } from '../editor/settings.js';
import { readEditorEnvVar } from '../editor/install.js';
import { editorTargetAccount } from '../editor/junction.js';
import { isShimInstalled, shimHasFallback } from '../shell/install-shim.js';
import { defaultPowerShellProfile, defaultPosixProfile } from '../shell/profile-path.js';
import { isLink, readTarget } from '../daemon/junction.js';
import { readToken } from '../daemon/token-store.js';
import { defaultClaudeRoot } from '../session/shared-root.js';
import { listAccounts } from '../accounts/registry.js';
import { loadLedger } from '../ledger/ledger.js';
import { probeAll } from '../health/prober.js';
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
  /** Shell-profile resolver for the shim check; injected in tests. */
  resolveShimProfile?: () => string | null;
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

function defaultShimProfile(context: CliContext): string | null {
  try {
    const platform = context.ctx.platform ?? process.platform;
    return platform === 'win32'
      ? defaultPowerShellProfile(context.ctx)
      : defaultPosixProfile(context.ctx);
  } catch {
    return null;
  }
}

/** The transparent `claude` shim: installed, and safe to uninstall ccx under? */
export function auditShim(context: CliContext, deps: DoctorDeps = {}): DoctorCheck {
  const profile = (deps.resolveShimProfile ?? (() => defaultShimProfile(context)))();
  if (!profile) {
    return { name: 'terminal-shim', ok: true, detail: 'could not resolve a shell profile (skipped)' };
  }
  if (!isShimInstalled(profile)) {
    return {
      name: 'terminal-shim',
      ok: true,
      detail: `not installed; \`claude\` runs stock (run: ccx on to enable auto-switching)`,
    };
  }
  if (!shimHasFallback(profile)) {
    return {
      name: 'terminal-shim',
      ok: false,
      detail: `outdated shim in ${profile}: uninstalling ccx would break \`claude\` (run: ccx on to upgrade)`,
    };
  }
  return { name: 'terminal-shim', ok: true, detail: `installed in ${profile}, with safe fallback` };
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

/** Session history: ccx must SHARE ~/.claude/projects, never fork it. */
export function auditSharedHistory(context: CliContext): DoctorCheck {
  const name = 'shared-history';
  const sessionDir = path.join(configHome(context.ctx), 'session');
  const link = path.join(sessionDir, 'projects');
  if (!existsSync(sessionDir)) {
    return { name, ok: true, detail: 'no ccx session yet (links on first session)' };
  }
  if (isLink(link)) {
    let expected: string;
    try {
      expected = path.join(defaultClaudeRoot(context.ctx), 'projects');
    } catch {
      return { name, ok: true, detail: 'linked (no resolvable home to compare against)' };
    }
    const target = readTarget(link) ?? '';
    return samePath(target, expected)
      ? { name, ok: true, detail: '/resume history and memories shared with ~/.claude' }
      : { name, ok: false, detail: `session projects points at ${target}, expected ${expected}` };
  }
  if (existsSync(link)) {
    return {
      name,
      ok: false,
      detail: 'session history is FORKED from ~/.claude (self-heals at the start of your next ccx session)',
    };
  }
  return { name, ok: true, detail: 'links to ~/.claude/projects on the next session' };
}

/** Account health: REAL login state per account (probed), naming who needs login. */
export async function auditAccounts(context: CliContext): Promise<DoctorCheck> {
  const name = 'accounts';
  const accounts = listAccounts(context.ctx);
  if (accounts.length === 0) {
    return { name, ok: true, detail: 'no accounts registered yet (run: ccx add <name>)' };
  }
  let loggedInNames: Set<string>;
  try {
    // Ask claude itself: a credential FILE can exist while its token is dead,
    // and a doctor that reports a dead login as healthy is worse than none.
    const healths = await probeAll(accounts, { claude: getClaude(context) });
    loggedInNames = new Set(healths.filter((h) => h.loggedIn).map((h) => h.name));
  } catch {
    loggedInNames = new Set(
      accounts
        .filter((a) => existsSync(path.join(a.dir, '.credentials.json')) || readToken(a.dir) !== null)
        .map((a) => a.name),
    );
  }
  const out = accounts.filter((a) => !loggedInNames.has(a.name));
  const fix = out.length > 0 ? ` (${out.map((a) => `ccx login ${a.name}`).join('; ')})` : '';
  return {
    name,
    ok: accounts.some((a) => a.enabled && loggedInNames.has(a.name)),
    detail: `${loggedInNames.size}/${accounts.length} logged in${fix}`,
  };
}

/** Cap state: informational, but every-enabled-account-capped is a failure. */
export function auditCaps(context: CliContext): DoctorCheck {
  const name = 'caps';
  const now = Date.now();
  const active = loadLedger(context.ctx).caps.filter((c) => c.capUntil && c.capUntil > now);
  if (active.length === 0) return { name, ok: true, detail: 'no accounts marked capped' };
  const enabled = listAccounts(context.ctx).filter((a) => a.enabled);
  const allCapped = enabled.length > 0 && enabled.every((a) => active.some((c) => c.account === a.name));
  const list = active
    .map((c) => `${c.account} (${Math.max(1, Math.round(((c.capUntil ?? now) - now) / 60000))}m left)`)
    .join(', ');
  return {
    name,
    ok: !allCapped,
    detail: allCapped ? `EVERY enabled account is marked capped: ${list}` : `capped: ${list}`,
  };
}

/** Informational: report which installed editors are pointed at ccx. */
export function auditEditor(context: CliContext): DoctorCheck {
  const editors = detectEditors(context.ctx);
  if (editors.length === 0) {
    return { name: 'editor', ok: true, detail: 'no Cursor/VS Code detected' };
  }
  const target = editorTargetAccount(context);
  const parts = editors.map((e) => {
    const configured = readEditorEnvVar(e, 'CLAUDE_CONFIG_DIR', context.ctx) !== null;
    if (!configured) return `${e} not set up (run: ccx on)`;
    if (target) return `${e} uses "${target.name}"${target.loggedIn ? '' : ' (needs login)'}`;
    return `${e} set up`;
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
    auditShim(context, deps),
    auditSharedHistory(context),
    await auditAccounts(context),
    auditCaps(context),
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
