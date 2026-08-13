import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { auditSessionAccount } from './doctor-session-account.js';
import { configHome, profilesDir } from '../config/paths.js';
import { detectEditors } from '../editor/settings.js';
import { readEditorEnvVar } from '../editor/install.js';
import { editorTargetAccount } from '../editor/junction.js';
import { isShimInstalled, shimHasFallback } from '../shell/install-shim.js';
import { defaultPowerShellProfile, defaultPosixProfile } from '../shell/profile-path.js';
import { isLink, readTarget } from '../daemon/junction.js';
import { hasWorkingLogin } from '../accounts/account-login.js';
import { defaultClaudeRoot } from '../session/shared-root.js';
import { listAccounts } from '../accounts/registry.js';
import { getActive } from '../state/active.js';
import { liveLeases } from '../session/lease.js';
import { verifyAccountIdentities } from '../accounts/identity-check.js';
import { sharedLoginGroups } from '../accounts/duplicate-guard.js';
import { loadLedger } from '../ledger/ledger.js';
import { probeAll } from '../health/prober.js';
import { codes, paint } from '../ui/style.js';
import { getClaude, type CliContext } from '../context.js';
import type { ClaudeInvoker } from '../invoker.js';
import { signedInAndNotRejected } from '../health/signed-in.js';
import { settingsPath, readSettings, isOurs } from '../statusline/settings-install.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** Commands that would resolve this, shown together at the end. */
  fix?: string[];
  /** Worth mentioning, but not a failure (e.g. an optional integration is off). */
  note?: boolean;
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
  /** Skip checks that need the network (used by tests and offline runs). */
  skipNetwork?: boolean;
  /** Injected in tests for the identity check. */
  fetchImpl?: typeof fetch;
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
    detail: `${home}${existsSync(home) ? '' : ' (not created yet)'}`,
    ...(profiles.startsWith(home) ? {} : { note: false }),
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
    ...(reachable ? {} : { note: true }),
    detail: reachable
      ? `Chrome is reachable for automatic sign-in (port ${port})`
      : `automatic sign-in unavailable; ccx login opens a browser for you instead`,
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
      note: true,
      detail: 'not installed; `claude` runs on its own',
      fix: ['ccx on'],
    };
  }
  if (!shimHasFallback(profile)) {
    return {
      name: 'terminal-shim',
      ok: false,
      detail: 'an old shim is installed; removing ccx would break `claude`',
      fix: ['ccx on'],
    };
  }
  return { name: 'terminal-shim', ok: true, detail: 'typing `claude` runs through ccx' };
}

/**
 * Is ccx visible while Claude is running?
 *
 * The shim is transparent by design, so nothing on screen says ccx is on. The
 * status line is the one place that can, which makes "is it wired up" worth
 * reporting rather than leaving someone to wonder whether switching is
 * happening at all.
 */
export function auditStatusline(context: CliContext): DoctorCheck {
  const file = (() => {
    try {
      return settingsPath(context.ctx);
    } catch {
      return null;
    }
  })();
  if (!file) return { name: 'statusline', ok: true, detail: 'no Claude settings to check (skipped)' };

  const read = readSettings(file);
  if (!read.ok) {
    return {
      name: 'statusline',
      ok: false,
      // Unreadable covers more than bad syntax: no permission to read the
      // file, or valid JSON that is not a settings object. Naming only one
      // cause would send someone looking in the wrong place.
      detail: `${file} could not be read as settings, so ccx will not change it`,
      fix: ['make the file readable and a valid JSON object, then run: ccx on'],
    };
  }
  if (isOurs(read.settings.statusLine)) {
    return { name: 'statusline', ok: true, detail: 'Claude shows your account and remaining room' };
  }
  if (read.settings.statusLine) {
    return {
      name: 'statusline',
      ok: true,
      note: true,
      detail: 'your own status line is in place; ccx is not shown in it',
      fix: ['ccx on'],
    };
  }
  return {
    name: 'statusline',
    ok: true,
    note: true,
    detail: 'nothing on screen says which account you are on',
    fix: ['ccx on'],
  };
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The session directory worth inspecting.
 *
 * Sessions get one each now, so there is no single fixed path to look at. A
 * running one is the honest subject; the pre-split single directory is the
 * fallback so a session started before the upgrade is still reported on.
 */
function currentSessionDir(context: CliContext): string {
  const live = liveLeases(context.ctx)
    .map((lease) => lease.configDir)
    .filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);
  // liveLeases sorts oldest first, so the LAST entry is the most recently
  // refreshed session, which is the honest subject to inspect.
  return live[live.length - 1] ?? path.join(configHome(context.ctx), 'session');
}

/** Session history: ccx must SHARE ~/.claude/projects, never fork it. */
export function auditSharedHistory(context: CliContext): DoctorCheck {
  const name = 'shared-history';
  const sessionDir = currentSessionDir(context);
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
    loggedInNames = signedInAndNotRejected(healths, accounts, context.ctx);
  } catch {
    loggedInNames = new Set(
      accounts
        .filter((a) => hasWorkingLogin(a.dir, context.ctx))
        .map((a) => a.name),
    );
  }
  const out = accounts.filter((a) => !loggedInNames.has(a.name));
  return {
    name,
    ok: accounts.some((a) => a.enabled && loggedInNames.has(a.name)),
    detail: `${loggedInNames.size} of ${accounts.length} signed in`,
    ...(out.length > 0 ? { fix: out.map((a) => `ccx login ${a.name}`), note: true } : {}),
  };
}

/**
 * Confirm each profile holds the account it claims to. This is the only check
 * that can catch profiles that have been scrambled or that share one login,
 * because local files report the recorded identity, not the token's owner.
 */
export async function auditIdentities(
  context: CliContext,
  deps: DoctorDeps = {},
): Promise<DoctorCheck> {
  const name = 'account-identity';
  const accounts = listAccounts(context.ctx);
  if (accounts.length === 0) return { name, ok: true, detail: 'no accounts registered' };
  if (deps.skipNetwork) return { name, ok: true, detail: 'skipped (no network checks)' };

  const findings = await verifyAccountIdentities(
    accounts.map((a) => ({ name: a.name, dir: a.dir, ...(a.email ? { email: a.email } : {}) })),
    deps.fetchImpl ?? fetch,
  );
  const broken = findings.filter((f) => f.kind === 'mismatch' || f.kind === 'duplicate');
  if (broken.length === 0) {
    const loggedOut = findings.filter((f) => f.kind === 'logged-out').length;
    return {
      name,
      ok: true,
      detail:
        loggedOut > 0
          ? `${findings.length - loggedOut} confirmed, ${loggedOut} not signed in`
          : 'every profile holds the account it should',
    };
  }
  return {
    name,
    ok: false,
    detail: broken.map((f) => `${f.account} ${f.detail.replace(/ \(run: [^)]+\)/, '')}`).join('; '),
    fix: broken.map((f) => `ccx login ${f.account}`),
  };
}

/**
 * Do any two profiles hold the same login?
 *
 * Checked locally and without the network, because this is the state that
 * destroys accounts: renewing a shared login ends it for the other profile. It
 * needs to be visible immediately, not only when a network check is possible.
 */
export function auditSharedLogins(context: CliContext): DoctorCheck {
  const name = 'separate-logins';
  const groups = sharedLoginGroups(listAccounts(context.ctx));
  if (groups.length === 0) {
    return { name, ok: true, detail: 'no two accounts share a sign-in that renewal could end' };
  }
  return {
    name,
    ok: false,
    detail: groups
      .map((g) => `${g.names.join(' and ')} hold the SAME sign-in; renewing either would end the other`)
      .join('; '),
    fix: groups.flatMap((g) => g.names.slice(1)).map((n) => `ccx login ${n}`),
  };
}

/**
 * Cap state: informational, unless nothing is left to run on.
 *
 * "Left to run on" counts the accounts that could ACTUALLY start a session, not
 * the enabled ones. An account whose login the token endpoint has refused is
 * still enabled and cannot be used, so counting it hid the situation this check
 * exists for: every usable account capped while a couple of dead profiles made
 * the total look healthy. That is exactly the state it reported "ok" in.
 */
export function auditCaps(context: CliContext): DoctorCheck {
  const name = 'caps';
  const now = Date.now();
  const active = loadLedger(context.ctx).caps.filter((c) => c.capUntil && c.capUntil > now);
  if (active.length === 0) return { name, ok: true, detail: 'no accounts marked capped' };

  const enabled = listAccounts(context.ctx).filter((a) => a.enabled);
  const usable = enabled.filter((a) => hasWorkingLogin(a.dir, context.ctx));
  const isCapped = (account: { name: string }): boolean =>
    active.some((c) => c.account === account.name);
  const list = active
    .map((c) => `${c.account} (${Math.max(1, Math.round(((c.capUntil ?? now) - now) / 60000))}m left)`)
    .join(', ');

  if (usable.length > 0 && usable.every(isCapped)) {
    const needSignIn = enabled.filter((a) => !usable.includes(a)).map((a) => a.name);
    return {
      name,
      ok: false,
      detail:
        `every account you can actually use is capped: ${list}` +
        (needSignIn.length
          ? `. The rest need signing in first: ${needSignIn.join(', ')}`
          : ''),
      ...(needSignIn.length ? { fix: needSignIn.map((n) => `ccx login ${n}`) } : {}),
    };
  }
  return { name, ok: true, detail: `capped: ${list}` };
}

/** Informational: report which installed editors are pointed at ccx. */
export function auditEditor(context: CliContext): DoctorCheck {
  const editors = detectEditors(context.ctx);
  if (editors.length === 0) {
    return { name: 'editor', ok: true, detail: 'no Cursor or VS Code found' };
  }
  const target = editorTargetAccount(context);
  const unset = editors.filter((e) => readEditorEnvVar(e, 'CLAUDE_CONFIG_DIR', context.ctx) === null);
  if (unset.length === editors.length) {
    return {
      name: 'editor',
      ok: true,
      note: true,
      detail: `${editors.join(' and ')} not set up to follow your account`,
      fix: ['ccx on'],
    };
  }
  const following = target ? `following "${target.name}"` : 'set up';
  return {
    name: 'editor',
    ok: true,
    detail: unset.length === 0 ? `${editors.join(' and ')} ${following}` : `${following}; ${unset.join(', ')} not set up`,
    ...(unset.length > 0 ? { fix: ['ccx on'], note: true } : {}),
  };
}

export async function runDoctor(
  context: CliContext,
  deps: DoctorDeps = {},
): Promise<{ checks: DoctorCheck[]; ok: boolean }> {
  const trackedFiles = (deps.gitTrackedFiles ?? defaultTrackedFiles)();
  const checks = [
    auditConfig(context),
    auditShim(context, deps),
    auditStatusline(context),
    auditSharedHistory(context),
    auditSessionAccount({
      sessionDir: currentSessionDir(context),
      activeAccount: getActive(context.ctx),
      accounts: listAccounts(context.ctx),
      leases: liveLeases(context.ctx),
    }),
    await auditAccounts(context),
    auditSharedLogins(context),
    await auditIdentities(context, deps),
    auditCaps(context),
    auditGitSafety(trackedFiles),
    auditRealClaude(context, deps),
    auditEditor(context),
    await auditBrowserPort(context, deps),
  ];
  return { checks, ok: checks.every((c) => c.ok) };
}

/** Human-friendly names, so the report reads like sentences rather than keys. */
const LABELS: Record<string, string> = {
  config: 'config',
  'terminal-shim': 'terminal',
  statusline: 'status line',
  'shared-history': 'history',
  'session-account': 'session',
  accounts: 'accounts',
  'account-identity': 'identity',
  'separate-logins': 'separate logins',
  caps: 'limits',
  'git-safety': 'git safety',
  'real-claude': 'claude',
  editor: 'editor',
  'browser-debug-port': 'browser',
};

/** Print the doctor report and return 0 when all checks pass, 1 otherwise. */
export async function doctorCommand(context: CliContext, deps: DoctorDeps = {}): Promise<number> {
  const { checks, ok } = await runDoctor(context, deps);
  const color = process.stdout.isTTY === true && !context.json;

  if (context.json) {
    context.out(JSON.stringify({ schemaVersion: 1, ok, checks }, null, 2));
    return ok ? 0 : 1;
  }

  const labelFor = (check: DoctorCheck): string => LABELS[check.name] ?? check.name;
  const width = Math.max(...checks.map((c) => labelFor(c).length));

  context.out('');
  context.out(`${paint('claude-auto-switch', codes.bold, color)}  ${paint('checkup', codes.dim, color)}`);
  context.out('');

  for (const check of checks) {
    // Three states, because "fine but worth knowing" is not a failure: a green
    // dot for healthy, yellow for an optional thing that is off, red for broken.
    const mark = !check.ok
      ? paint('✗', codes.red, color)
      : check.note
        ? paint('●', codes.yellow, color)
        : paint('●', codes.green, color);
    const label = labelFor(check).padEnd(width);
    const detail = check.ok ? paint(check.detail, codes.dim, color) : check.detail;
    context.out(`  ${mark} ${paint(label, codes.bold, color && !check.ok)}  ${detail}`);
  }

  const fixes = [...new Set(checks.flatMap((c) => c.fix ?? []))];
  context.out('');
  if (ok && fixes.length === 0) {
    context.out(`  ${paint('everything is in order', codes.green, color)}`);
  } else if (ok) {
    context.out(`  ${paint('nothing is broken. optional next steps:', codes.dim, color)}`);
    for (const fix of fixes) context.out(`    ${paint(fix, codes.cyan, color)}`);
  } else {
    const broken = checks.filter((c) => !c.ok);
    context.out(
      `  ${paint(`${broken.length} problem${broken.length === 1 ? '' : 's'} found:`, codes.red, color)}`,
    );
    if (fixes.length > 0) {
      for (const fix of fixes) context.out(`    ${paint(fix, codes.cyan, color)}`);
    } else {
      // Nothing scripted can fix these, so at least name them plainly.
      for (const check of broken) context.out(`    ${labelFor(check)}: ${check.detail}`);
    }
  }
  context.out('');
  return ok ? 0 : 1;
}
