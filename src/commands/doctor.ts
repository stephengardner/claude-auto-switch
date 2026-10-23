import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { browserPortReachable } from '../login/browser.js';
import { findKeepalive } from '../keepalive/crontab.js';
import {
  expectedKeepalive,
  keepaliveIsCurrent,
  systemCrontab,
  type KeepaliveDeps,
} from './keepalive.js';
import { isHeadlessSession } from '../util/headless.js';
import { auditSessionAccount } from './doctor-session-account.js';
import { configHome, profilesDir } from '../config/paths.js';
import { configFilePath } from '../config/config.js';
import { CREDENTIALS_FILE, PREVIOUS_FILE } from '../accounts/credential-vault.js';
import { TOKEN_FILE } from '../daemon/token-store.js';
import { detectEditors } from '../editor/settings.js';
import { readEditorEnvVar } from '../editor/install.js';
import { editorStanding, refreshEditor } from '../editor/folder.js';
import { isShimInstalled, shimHasFallback, shimIsCurrent } from '../shell/install-shim.js';
import { shellPlans, type ShellPlan } from '../shell/shells.js';
import { isLink, readTarget } from '../daemon/junction.js';
import { hasWorkingLogin } from '../accounts/account-login.js';
import { defaultClaudeRoot } from '../session/shared-root.js';
import { getAccount, listAccounts } from '../accounts/registry.js';
import { liveLeases } from '../session/lease.js';
import { verifyAccountIdentities } from '../accounts/identity-check.js';
import { sharedLoginGroups } from '../accounts/duplicate-guard.js';
import { loadLedger } from '../ledger/ledger.js';
import { probeAll } from '../health/prober.js';
import { codes, paint } from '../ui/style.js';
import { claudeRepairDeps, getClaudeAsIs, type CliContext } from '../context.js';
import {
  cannotFindClaude,
  describeBrokenInstall,
  findRealClaude,
  type ClaudeSearch,
} from '../launcher/real-claude.js';
import {
  fileRepairMemory,
  nodeRepairFs,
  REPAIR_MEMORY,
  repairClaudeInstalls,
  stampOf,
  type RepairMemory,
} from '../launcher/claude-repair.js';
import type { ClaudeInvoker } from '../invoker.js';
import { signedInAndNotRejected } from '../health/signed-in.js';
import { lentLoginIn } from '../lending/lent-login.js';
import { settingsPath, readSettings, isOurs } from '../statusline/settings-install.js';
import { installedHooksProblem, readInstalledHandoff } from '../desktop/hooks.js';
import { artifactHooksInstalled, artifactHooksProblem, withoutArtifactHooks } from '../artifacts/hooks.js';
import { routingOn } from '../artifacts/route.js';

export interface DoctorCheck {
  name: string;
  /** For a shell's check: which shell, by its ccx name (`zsh`, `pwsh`, `cmd`). */
  shell?: string;
  /** Shown instead of the name's label: a shell's own name. */
  label?: string;
  ok: boolean;
  detail: string;
  /** Commands that would resolve this, shown together at the end. */
  fix?: string[];
  /** Worth mentioning, but not a failure (e.g. an optional integration is off). */
  note?: boolean;
}

/** A folder as git sees it from inside. */
export interface GitTracked {
  /** The top folder of the repository the folder is in, symbolic links resolved as git does. */
  repo: string;
  /** The files git tracks under the folder, relative to it, with forward slashes. */
  files: string[];
  /** Why git found the repository but could not list its files, so nothing there was checked. */
  unreadable?: string;
}

export interface DoctorDeps {
  /** What git tracks under a folder, null outside a work tree (runs git by default); injected in tests. */
  gitTracked?: (folder: string) => GitTracked | null;
  /** Claude resolver, standing in for the whole search; injected in tests. */
  resolveClaude?: () => ClaudeInvoker;
  /** The search for Claude, repairing nothing; injected in tests. */
  findClaude?: () => ClaudeSearch;
  /** What `--fix` runs for a broken Claude Code npm install; injected in tests, which never run npm. */
  repairClaude?: () => string[];
  /** Repairs that failed, as ccx wrote them down; injected in tests. */
  repairMemory?: RepairMemory;
  /** Browser debug-port reachability probe; injected in tests. */
  checkBrowserPort?: (port: number) => Promise<boolean>;
  /** Whether nobody is at a browser here; read from the session when absent. */
  headless?: boolean;
  /** The user's crontab, or null when cron is unavailable; injected in tests. */
  readCrontab?: () => Promise<string | null>;
  /** The node and ccx keepalive should be running; injected in tests. */
  keepalive?: KeepaliveDeps;
  /** The shells and their files; injected in tests, worked out from the machine otherwise. */
  shellPlans?: ShellPlan[];
  /** Skip checks that need the network (used by tests and offline runs). */
  skipNetwork?: boolean;
  /** Injected in tests for the identity check. */
  fetchImpl?: typeof fetch;
}

/**
 * Login files, by name. These names mean a login wherever they turn up, so
 * they are all doctor looks for outside ccx's own folders, where a folder
 * called `profiles` or a file called `accounts.json` is somebody else's.
 */
const LOGIN_FILES = new Set([CREDENTIALS_FILE, PREVIOUS_FILE, TOKEN_FILE]);

/** How many tracked files a finding names before it only counts the rest. */
const SHOWN_FILES = 5;

/** A folder git is asked about. */
interface GitPlace {
  folder: string;
  /** How the report names it; a repository on its own goes by its location. */
  name?: string;
  /** Only login files count; otherwise every file does but ccx's settings and git's own. */
  loginsOnly: boolean;
}

/**
 * Is anything of ccx's, or a Claude login, tracked in git? Asked of ccx's
 * folders themselves, so a dotfiles repository is caught wherever doctor
 * runs. Its settings file may be kept in one on purpose; nothing else there
 * may. In `~/.claude` and in the repository doctor runs in, only a login file
 * counts.
 */
export function auditGitSafety(context: CliContext, deps: DoctorDeps = {}): DoctorCheck {
  const tracked = deps.gitTracked ?? gitTrackedUnder;
  // Paths here keep their case: where a filesystem tells `CONFIG.JSON` from
  // `config.json`, only the second is ccx's settings.
  const settings = path.resolve(configFilePath(context.ctx));
  const places: GitPlace[] = ccxFolders(context).map((folder, i) => ({
    folder,
    name: `${i === 0 ? "ccx's folder" : "ccx's profile folder"} ${folder}`,
    loginsOnly: false,
  }));
  try {
    const claude = defaultClaudeRoot(context.ctx);
    places.push({ folder: claude, name: `Claude's folder ${claude}`, loginsOnly: true });
  } catch {
    /* no home folder, so no Claude folder to ask about */
  }
  const working = workingFolder();
  const workingRepo = working === null ? null : tracked(working);
  if (workingRepo) places.push({ folder: workingRepo.repo, loginsOnly: true });

  const counts = (place: GitPlace, file: string): boolean => {
    const name = path.posix.basename(file);
    if (place.loginsOnly) return LOGIN_FILES.has(name);
    return name !== '.gitignore' && path.resolve(place.folder, file) !== settings;
  };

  // Several places can reach one file (the working repository can be the one
  // tracking ccx's folder), so each is reported only where it is first found.
  const reported = new Set<string>();
  const findings: string[] = [];
  const unchecked: string[] = [];
  for (const place of places) {
    const inGit = tracked(place.folder);
    if (!inGit) continue;
    if (inGit.unreadable) {
      const message = `could not check the git repository at ${inGit.repo}: ${inGit.unreadable}`;
      if (!unchecked.includes(message)) unchecked.push(message);
      continue;
    }
    const base = realFolder(place.folder);
    const files = inGit.files.filter((file) => {
      const key = path.resolve(base, file);
      if (!counts(place, file) || reported.has(key)) return false;
      reported.add(key);
      return true;
    });
    if (files.length > 0) findings.push(describeTracked(place, inGit.repo, files));
  }
  if (findings.length === 0 && unchecked.length === 0) {
    return {
      name: 'git-safety',
      ok: true,
      detail: "ccx's folders and Claude's logins are not tracked in git",
    };
  }
  // A repository git cannot list is worth knowing about, but is no failure.
  return {
    name: 'git-safety',
    ok: findings.length === 0,
    detail: [...findings, ...unchecked].join('; '),
    ...(findings.length === 0 ? { note: true } : {}),
  };
}

/** ccx's folder first, then where profiles are kept and each account's own folder, once each. */
function ccxFolders(context: CliContext): string[] {
  const folders = [configHome(context.ctx), profilesDir(context.config, context.ctx)];
  try {
    folders.push(...listAccounts(context.ctx).map((account) => account.dir));
  } catch {
    /* an unreadable account list is the accounts check's to report */
  }
  return folders.filter(
    (folder, i) => folders.findIndex((other) => path.resolve(other) === path.resolve(folder)) === i,
  );
}

function describeTracked(place: GitPlace, repo: string, files: string[]): string {
  const listed =
    files.length > SHOWN_FILES
      ? `${files.slice(0, SHOWN_FILES).join(', ')} and ${files.length - SHOWN_FILES} more`
      : files.join(', ');
  const count = place.loginsOnly
    ? `${files.length} login file${files.length === 1 ? '' : 's'}`
    : `${files.length} of its files`;
  if (!place.name) return `the git repository at ${repo} tracks ${count}: ${listed}`;
  if (samePath(realFolder(place.folder), repo)) {
    return `${place.name} is a git repository that tracks ${count}: ${listed}`;
  }
  return `${place.name} is in the git repository at ${repo}, which tracks ${count}: ${listed}`;
}

/** The folder doctor was started in, or null when it has been deleted since. */
function workingFolder(): string | null {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

function realFolder(folder: string): string {
  try {
    return realpathSync.native(folder);
  } catch {
    return path.resolve(folder);
  }
}

/**
 * Variables that change which repository git finds for a folder: those a git
 * hook exports to point at its own, and the ceiling people with their home
 * folder in git set so other folders do not look part of it, which would
 * hide exactly that repository here.
 */
const REPOSITORY_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
];

/**
 * Asks git from inside the folder. Null when it is in no work tree, is
 * missing, or git cannot run; a repository whose files git cannot list says
 * so, since passing it would vouch for files nobody read.
 */
export function gitTrackedUnder(folder: string): GitTracked | null {
  if (!existsSync(folder)) return null;
  const env = { ...process.env };
  for (const name of REPOSITORY_VARIABLES) delete env[name];
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', folder, ...args], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
      // Node's default, 1 MiB, is shorter than a large repository's list of files.
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  let top: string;
  try {
    top = git('rev-parse', '--show-toplevel').trim();
  } catch {
    return null;
  }
  if (top.length === 0) return null;
  const repo = path.resolve(top);
  try {
    const files = git('ls-files', '-z')
      .split('\0')
      .filter((file) => file.length > 0);
    return { repo, files };
  } catch {
    return { repo, files: [], unreadable: 'git could not list its files' };
  }
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

/**
 * Which claude ccx would start. Only looks: a Claude Code npm install that has
 * lost its program is reported with `ccx doctor --fix`, which repairs it, as
 * starting Claude through ccx would.
 */
function auditRealClaude(context: CliContext, deps: DoctorDeps): DoctorCheck {
  const name = 'real-claude';
  if (deps.resolveClaude || context.claude || context.config.realClaudePath) {
    try {
      const claude = (deps.resolveClaude ?? (() => getClaudeAsIs(context)))();
      return { name, ok: true, detail: `resolved to ${claude.bin}` };
    } catch (err) {
      return { name, ok: false, detail: (err as Error).message };
    }
  }
  const platform = context.ctx.platform ?? process.platform;
  const search = (deps.findClaude ?? (() => findRealClaude({ platform })))();
  const resolved = `resolved to ${[search.bin, ...search.prefixArgs].join(' ')}`;
  if (search.broken.length === 0) {
    return search.bin
      ? { name, ok: true, detail: resolved }
      : { name, ok: false, detail: cannotFindClaude(search.candidates, platform) };
  }
  const repair = { fix: ['ccx doctor --fix'] };
  const failed = rememberedFailures(context, deps, search);
  if (!search.bin) {
    const detail = cannotFindClaude(search.candidates, platform, search.broken);
    return { name, ok: false, detail: failed.length > 0 ? `${detail}\n${failed.join('\n')}` : detail, ...repair };
  }
  return {
    name,
    ok: true,
    note: true,
    detail: [
      `${resolved}, but Claude Code's npm install is missing its program: ${search.broken.map(describeBrokenInstall).join('; ')}`,
      ...failed,
    ].join('; '),
    ...repair,
  };
}

/** What ccx wrote down about a repair that failed on an install, while the install is as it left it. */
function rememberedFailures(context: CliContext, deps: DoctorDeps, search: ClaudeSearch): string[] {
  let memory: RepairMemory;
  try {
    memory = deps.repairMemory ?? fileRepairMemory(path.join(configHome(context.ctx), REPAIR_MEMORY));
  } catch {
    return [];
  }
  return search.broken.flatMap((install) => {
    const failed = memory.get(install.folder);
    return failed && failed.stamp === stampOf(install, nodeRepairFs)
      ? [`ccx's last repair of ${install.folder}, on ${failed.at}, did not work: ${failed.reason}`]
      : [];
  });
}

/**
 * `ccx doctor --fix`: the repair a launch makes, of every broken npm install
 * the search finds, including one an earlier repair failed on.
 */
function repairClaudeIfBroken(context: CliContext, deps: DoctorDeps): void {
  if (deps.resolveClaude || context.claude || context.config.realClaudePath) return;
  const platform = context.ctx.platform ?? process.platform;
  const search = (deps.findClaude ?? (() => findRealClaude({ platform })))();
  if (search.broken.length === 0) return;
  (deps.repairClaude ?? (() => repairClaudeInstalls(claudeRepairDeps(context), { force: true })))();
}

/** Informational: is Chrome listening on the debug port (needed only for auto-login)? */
async function auditBrowserPort(context: CliContext, deps: DoctorDeps): Promise<DoctorCheck> {
  const port = context.config.browser.debugPort;
  const reachable = await (deps.checkBrowserPort ?? browserPortReachable)(port);
  if (reachable) {
    return {
      name: 'browser-debug-port',
      ok: true,
      detail: `Chrome is reachable for automatic sign-in (port ${port})`,
    };
  }
  return {
    name: 'browser-debug-port',
    ok: true,
    note: true,
    detail: headless(context, deps)
      ? 'no browser on this machine; ccx login shows a link and takes the pasted code, or sign in from a machine with one: ccx login --host <this machine>'
      : 'automatic sign-in unavailable; ccx login opens a browser for you instead',
  };
}

/**
 * On a machine nobody sits at, is anything renewing idle logins? Asked only
 * there: a desktop renews them whenever Claude or the status line runs.
 */
async function auditKeepalive(context: CliContext, deps: DoctorDeps): Promise<DoctorCheck | null> {
  if (!headless(context, deps) || (context.ctx.platform ?? process.platform) === 'win32') return null;
  const crontab = await (deps.readCrontab ?? (() => systemCrontab.read()))();
  if (crontab === null) return null;
  const line = findKeepalive(crontab);
  if (line && keepaliveIsCurrent(line, expectedKeepalive(context, deps.keepalive), deps.keepalive?.exists)) {
    return { name: 'keepalive', ok: true, detail: 'idle logins are renewed every four hours' };
  }
  return {
    name: 'keepalive',
    ok: true,
    note: true,
    detail: line
      ? 'the keepalive job runs a node or ccx that is not this one, so it renews nothing'
      : 'nothing renews idle logins here, and a machine nobody uses for a day can lose them',
    fix: ['ccx keepalive on'],
  };
}

function headless(context: CliContext, deps: DoctorDeps): boolean {
  return (
    deps.headless ??
    isHeadlessSession(context.ctx.env ?? process.env, context.ctx.platform ?? process.platform)
  );
}

/**
 * Each shell, and whether typing `claude` in it goes through ccx. Read from
 * the files each shell loads at startup, never by starting the shell, which
 * would run whatever else those files do. Changes nothing, the execution
 * policy included: that is for the person to decide.
 */
export function auditShells(context: CliContext, deps: DoctorDeps = {}): DoctorCheck[] {
  let plans: ShellPlan[];
  try {
    plans = deps.shellPlans ?? shellPlans(context.ctx);
  } catch {
    return [{ name: 'terminal-shim', ok: true, detail: 'could not work out your shells (skipped)' }];
  }
  const has = (file: string): boolean => {
    try {
      return isShimInstalled(file);
    } catch {
      return false;
    }
  };
  const onSomewhere = plans.some((p) => [...p.files, ...p.retired].some(has));
  const checks = plans.filter((p) => p.state !== 'absent').map((plan) => auditShell(plan, has, onSomewhere));
  if ((context.ctx.platform ?? process.platform) === 'win32') {
    checks.push({
      name: 'terminal-shim',
      shell: 'cmd',
      label: 'cmd',
      ok: true,
      note: true,
      detail: 'not covered: cmd has no profile to put `claude` in, so there it runs on its own (use ccx run, or PowerShell)',
    });
  }
  return checks;
}

function auditShell(plan: ShellPlan, has: (file: string) => boolean, onSomewhere: boolean): DoctorCheck {
  const base = { name: 'terminal-shim', shell: plan.id, label: plan.label };
  if (plan.state === 'unused') {
    return { ...base, ok: true, note: true, detail: `left alone, ${plan.why} (ccx on --shell ${plan.id} adds it)` };
  }
  if (plan.blocked) {
    // A note, not a failure: the policy is the machine's, often chosen, and
    // plenty of people never open this shell. It also stops npm's ccx command.
    return {
      ...base,
      ok: true,
      note: true,
      detail: `\`claude\` skips ccx here: ${plan.blocked.detail}`,
      ...(plan.blocked.fix ? { fix: [plan.blocked.fix] } : {}),
    };
  }
  const missing = plan.files.filter((f) => !has(f));
  if (missing.length === plan.files.length) {
    return onSomewhere
      ? {
          ...base,
          ok: false,
          detail: `\`claude\` skips ccx here, while other shells have it: no shim in ${missing.join(', ')}`,
          fix: ['ccx on'],
        }
      : { ...base, ok: true, note: true, detail: '`claude` runs on its own here', fix: ['ccx on'] };
  }
  if (missing.length > 0) {
    return {
      ...base,
      ok: false,
      detail: `\`claude\` skips ccx in some ${plan.label} windows: no shim in ${missing.join(', ')}`,
      fix: ['ccx on'],
    };
  }
  if (plan.files.some((f) => !shimHasFallback(f))) {
    return { ...base, ok: false, detail: 'an old shim is installed; removing ccx would break `claude`', fix: ['ccx on'] };
  }
  if (plan.files.some((f) => !shimIsCurrent(f, plan.kind))) {
    return {
      ...base,
      ok: false,
      detail: 'the shim is from an older ccx (in PowerShell, `claude --version` and `claude --help` reached ccx)',
      fix: ['ccx on'],
    };
  }
  const extra = plan.retired.filter(has);
  if (extra.length > 0) {
    return {
      ...base,
      ok: false,
      detail: `${plan.label} also loads an older copy from ${extra.join(', ')}`,
      fix: ['ccx on'],
    };
  }
  return { ...base, ok: true, detail: `\`claude\` goes through ccx (${plan.files.join(', ')})` };
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
    const healths = await probeAll(accounts, { claude: getClaudeAsIs(context) });
    loggedInNames = signedInAndNotRejected(healths, accounts, context.ctx);
  } catch {
    loggedInNames = new Set(
      accounts
        .filter((a) => hasWorkingLogin(a.dir, context.ctx))
        .map((a) => a.name),
    );
  }
  const out = accounts.filter((a) => !loggedInNames.has(a.name));
  // A lend that ran out comes back from the machine that lends it, never from a sign-in here.
  const lendsOut = out.filter((a) => lentLoginIn(a.dir) !== null).map((a) => a.name);
  const signIn = out.filter((a) => !lendsOut.includes(a.name));
  return {
    name,
    ok: accounts.some((a) => a.enabled && loggedInNames.has(a.name)),
    detail:
      `${loggedInNames.size} of ${accounts.length} signed in` +
      (lendsOut.length > 0
        ? `; lend expired: ${lendsOut.join(', ')} (ccx lend sync on the machine that lends ${lendsOut.length === 1 ? 'it' : 'them'})`
        : ''),
    ...(signIn.length > 0 ? { fix: signIn.map((a) => `ccx login ${a.name}`), note: true } : {}),
    ...(signIn.length === 0 && lendsOut.length > 0 ? { note: true } : {}),
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
    const needSignIn = enabled.filter((a) => !usable.includes(a) && lentLoginIn(a.dir) === null).map((a) => a.name);
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
  const target = editorStanding(context);
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

/**
 * Can Claude run the Desktop handoff hooks? They name a node and a ccx by
 * path, and Claude runs them in every session, so a ccx moved or removed since
 * shows up as a broken hook everywhere.
 */
function auditDesktopHooks(context: CliContext): DoctorCheck | null {
  const when = readInstalledHandoff(context.ctx);
  if (when === 'off') return null;
  const problem = installedHooksProblem(context.ctx);
  return problem
    ? {
        name: 'desktop-hooks',
        ok: false,
        detail: `the Claude Desktop hooks cannot run: ${problem}`,
        fix: ['ccx on'],
      }
    : { name: 'desktop-hooks', ok: true, detail: `Desktop conversations move on: ${when}` };
}

/**
 * Page routing: its hooks are in Claude's settings exactly while it is on, can
 * run, and the home account is one of the accounts. Null when it is off and
 * nothing of it is installed, which is how most setups are.
 */
export function auditArtifactHooks(context: CliContext): DoctorCheck | null {
  const { home, updates } = context.config.artifacts;
  const on = routingOn(context.config.artifacts);
  // Setting it again writes the hooks as the settings call for, pointed at
  // this ccx, and touches nothing else: ccx on would also put back what a
  // ccx off took out. A home that is no account cannot be set again.
  let homeKnown = false;
  try {
    homeKnown = home !== null && getAccount(home, context.ctx) !== undefined;
  } catch {
    /* an unreadable account list is the accounts check's to report */
  }
  const reapply = homeKnown
    ? `ccx config artifacts.home ${home}`
    : updates === 'owner'
      ? 'ccx config artifacts.updates owner'
      : 'ccx config artifacts.home <account>';
  let file: string;
  try {
    file = settingsPath(context.ctx);
  } catch {
    return on
      ? { name: 'page-routing', ok: false, detail: 'could not find your Claude settings folder, so page routing cannot be checked' }
      : null;
  }
  const read = readSettings(file);
  if (!read.ok) {
    // ccx on refuses to rewrite a file that does not parse, so it is no fix here.
    return on
      ? {
          name: 'page-routing',
          ok: false,
          detail: `${file} is not valid JSON, so the page routing hooks cannot be checked or installed; fix that file, then run ${reapply}`,
        }
      : null;
  }
  const settings = read.settings;
  const installed = artifactHooksInstalled(settings);
  if (!on) {
    if (JSON.stringify(withoutArtifactHooks(settings)) === JSON.stringify(settings)) return null;
    return {
      name: 'page-routing',
      ok: false,
      detail: 'page routing is off, but its hooks are still in your Claude settings',
      fix: ['ccx config artifacts.updates off'],
    };
  }
  const problem = !installed
    ? 'page routing is on, but its hooks are not in your Claude settings, so nothing is routed'
    : (() => {
        const broken = artifactHooksProblem(settings);
        return broken ? `the page routing hooks cannot run: ${broken}` : null;
      })();
  if (problem) return { name: 'page-routing', ok: false, detail: problem, fix: [reapply] };
  if (home !== null && !getAccount(home, context.ctx)) {
    return {
      name: 'page-routing',
      ok: false,
      detail: `new pages are to be published as "${home}", which is not an account, so they are refused`,
      fix: ['ccx config artifacts.home <account>'],
    };
  }
  const what = [
    ...(home !== null ? [`new pages are published as "${home}"`] : []),
    ...(updates === 'owner' ? ['a page is changed as the account that owns it'] : []),
  ];
  return { name: 'page-routing', ok: true, detail: what.join('; ') };
}

export async function runDoctor(
  context: CliContext,
  deps: DoctorDeps = {},
): Promise<{ checks: DoctorCheck[]; ok: boolean }> {
  const checks = [
    auditConfig(context),
    ...auditShells(context, deps),
    auditStatusline(context),
    auditSharedHistory(context),
    auditSessionAccount({
      accounts: listAccounts(context.ctx),
      leases: liveLeases(context.ctx),
    }),
    await auditAccounts(context),
    auditSharedLogins(context),
    await auditIdentities(context, deps),
    auditCaps(context),
    auditGitSafety(context, deps),
    auditRealClaude(context, deps),
    auditEditor(context),
    await auditBrowserPort(context, deps),
    ...[await auditKeepalive(context, deps), auditDesktopHooks(context), auditArtifactHooks(context)].filter(
      (c): c is DoctorCheck => c !== null,
    ),
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
  keepalive: 'keepalive',
  'desktop-hooks': 'Claude Desktop',
  'page-routing': 'pages',
};

/**
 * Print the doctor report and return 0 when all checks pass, 1 otherwise.
 * With `fix`, first repair what ccx can repair by itself; the report then says
 * how things are after it.
 */
export async function doctorCommand(
  context: CliContext,
  deps: DoctorDeps = {},
  options: { fix?: boolean } = {},
): Promise<number> {
  if (options.fix) repairClaudeIfBroken(context, deps);
  // The editor's folder never ends; a checkup is one of the times it is brought into step.
  await refreshEditor(context);
  const { checks, ok } = await runDoctor(context, deps);
  const color = process.stdout.isTTY === true && !context.json;

  if (context.json) {
    context.out(JSON.stringify({ schemaVersion: 1, ok, checks }, null, 2));
    return ok ? 0 : 1;
  }

  const labelFor = (check: DoctorCheck): string => check.label ?? LABELS[check.name] ?? check.name;
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
