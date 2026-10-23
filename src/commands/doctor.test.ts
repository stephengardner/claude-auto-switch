import { afterEach, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  auditShells,
  auditSharedHistory,
  auditSharedLogins,
  auditCaps,
  auditCutShortLogins,
  doctorCommand,
  restoreCutShortLogins,
  runDoctor,
  type DoctorCheck,
} from './doctor.js';
import { configHome } from '../config/paths.js';
import type { BrokenNpmInstall, ClaudeSearch } from '../launcher/real-claude.js';
import { nodeRepairFs, stampOf, type RepairMemory } from '../launcher/claude-repair.js';
import { settingsPath } from '../statusline/settings-install.js';
import { addAccount } from '../accounts/registry.js';
import { takeLease } from '../session/lease.js';
import { installShim } from '../shell/install-shim.js';
import type { ShellPlan } from '../shell/shells.js';
import { loadConfig } from '../config/config.js';
import { credentialFileFingerprint } from '../accounts/credential-vault.js';
import { loadLedger, markCapped, updateLedger } from '../ledger/ledger.js';
import { expectedKeepalive } from './keepalive.js';
import type { CliContext } from '../context.js';

function context(lines: string[] = []): CliContext {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-doc-'));
  // A display, so a Linux runner is not taken for a machine nobody is at.
  const ctx = {
    env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home, DISPLAY: ':0' } as NodeJS.ProcessEnv,
  };
  return {
    ctx,
    config: loadConfig(ctx),
    out: (m) => lines.push(m),
    json: false,
    quiet: false,
  };
}

/** Put ccx into this sandbox's Claude status line, the way `ccx on` would. */
function wireStatusline(c: CliContext): void {
  const file = settingsPath(c.ctx);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ statusLine: { type: 'command', command: 'ccx statusline' } }),
    'utf8',
  );
}

describe('git safety', () => {
  const startedIn = process.cwd();
  afterEach(() => process.chdir(startedIn));

  // Nothing from the environment may point git at another repository, such as
  // this one's when the tests run from a git hook: `add` would stage into it.
  const gitEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  const git = (dir: string, args: string[], input = ''): string =>
    execFileSync('git', ['-C', dir, ...args], {
      env: gitEnv,
      input,
      encoding: 'utf8',
      stdio: 'pipe',
    });

  const freshFolder = (): string => mkdtempSync(path.join(tmpdir(), 'cas-git-'));
  const real = (folder: string): string => realpathSync.native(folder);

  /** A new git repository that tracks `files`, each made with placeholder text. */
  function repoTracking(files: string[]): string {
    const dir = freshFolder();
    git(dir, ['init', '-q']);
    for (const file of files) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), '{}\n', 'utf8');
    }
    if (files.length > 0) git(dir, ['add', '-f', '--', ...files]);
    return dir;
  }

  /** A home folder laid out as on a real machine: ccx's folder and ~/.claude side by side. */
  function machine(home = freshFolder()): CliContext {
    const ctx = {
      env: {
        CLAUDE_AUTO_SWITCH_HOME: path.join(home, '.claude-auto-switch'),
        HOME: home,
        USERPROFILE: home,
        DISPLAY: ':0',
      } as NodeJS.ProcessEnv,
    };
    return {
      ctx,
      config: loadConfig(ctx),
      // Never the real claude, which the accounts check runs once there are accounts.
      claude: { bin: path.join(home, 'no-claude-here') },
      out: () => {},
      json: false,
      quiet: false,
    };
  }

  /** The git safety check of a whole doctor run, in whatever folder this process is in. */
  async function check(context: CliContext): Promise<DoctorCheck> {
    const { checks } = await runDoctor(context, {
      resolveClaude: () => ({ bin: '/real/claude' }),
      checkBrowserPort: () => Promise.resolve(true),
      shellPlans: [],
      headless: false,
      skipNetwork: true,
    });
    const found = checks.find((c) => c.name === 'git-safety');
    if (!found) throw new Error('doctor ran no git safety check');
    return found;
  }

  /** The same, with doctor started in `folder` (by default one in no repository). */
  function gitSafety(context: CliContext, folder = freshFolder()): Promise<DoctorCheck> {
    process.chdir(folder);
    return check(context);
  }

  it("passes in a repository whose own profiles folder, accounts.json and ledger.json are not ccx's", async () => {
    // The case from issue #147: a load generator's settings in another project.
    const work = repoTracking([
      'accounts.json',
      'apps/traffic-gen/profiles/merchant/default.json',
      'apps/traffic-gen/profiles/shopper/default.json',
      'ledger.json',
    ]);
    expect(await gitSafety(machine(), work)).toMatchObject({
      ok: true,
      detail: "ccx's folders and Claude's logins are not tracked in git",
    });
  });

  it("fails when ccx's folder is in a repository that tracks its files, naming the folder, the repository and the files", async () => {
    // A dotfiles repository of the home folder, and doctor run from elsewhere.
    const home = repoTracking([
      '.claude-auto-switch/.gitignore',
      '.claude-auto-switch/accounts.json',
      '.claude-auto-switch/config.json',
      '.claude-auto-switch/ledger.json',
      '.claude-auto-switch/profiles/work/.credentials.json',
    ]);
    const context = machine(home);
    expect(await gitSafety(context)).toMatchObject({
      ok: false,
      detail:
        `ccx's folder ${configHome(context.ctx)} is in the git repository at ${real(home)}, ` +
        'which tracks 3 of its files: accounts.json, ledger.json, profiles/work/.credentials.json',
    });
  });

  it("leaves ccx's settings file and a .gitignore to a dotfiles repository that keeps them", async () => {
    const home = repoTracking(['.claude-auto-switch/.gitignore', '.claude-auto-switch/config.json']);
    expect((await gitSafety(machine(home))).ok).toBe(true);
  });

  it('in the repository it runs in, flags only login files, by exact name, and names the repository', async () => {
    const work = repoTracking([
      'accounts.json',
      'apps/traffic-gen/profiles/merchant/default.json',
      'backup/.credentials.json',
      'backup/.credentials.prev.json',
      'docs/oauth-token.md',
      'ledger.json',
      'tools/oauth-token',
    ]);
    // Started in a subfolder, it still reads the whole repository.
    expect(await gitSafety(machine(), path.join(work, 'apps'))).toMatchObject({
      ok: false,
      detail:
        `the git repository at ${real(work)} tracks 3 login files: ` +
        'backup/.credentials.json, backup/.credentials.prev.json, tools/oauth-token',
    });
  });

  it("asks about a profiles folder kept outside ccx's folder, and about each account's own folder", async () => {
    const profiles = repoTracking(['work/.credentials.json']);
    const stray = repoTracking(['oauth-token', 'settings.json']);
    const context = machine();
    context.config = { ...context.config, profilesDir: profiles };
    addAccount({ name: 'stray', dir: stray, enabled: true }, context.ctx);
    expect((await gitSafety(context)).detail).toBe(
      [
        `ccx's profile folder ${profiles} is a git repository that tracks 1 of its files: work/.credentials.json`,
        `ccx's profile folder ${stray} is a git repository that tracks 2 of its files: oauth-token, settings.json`,
      ].join('; '),
    );
  });

  it("in ~/.claude, flags only a login: CLAUDE.md, settings and skills kept in git are fine", async () => {
    const kept = ['.claude/CLAUDE.md', '.claude/settings.json', '.claude/skills/notes/SKILL.md'];
    expect((await gitSafety(machine(repoTracking(kept)))).ok).toBe(true);

    const home = repoTracking([...kept, '.claude/.credentials.json']);
    expect(await gitSafety(machine(home))).toMatchObject({
      ok: false,
      detail:
        `Claude's folder ${path.join(home, '.claude')} is in the git repository at ${real(home)}, ` +
        'which tracks 1 login file: .credentials.json',
    });
  });

  it("names a file once when the repository it runs in is the one tracking ccx's folder", async () => {
    const home = repoTracking([
      '.claude-auto-switch/profiles/work/.credentials.json',
      '.claude/.credentials.json',
    ]);
    const context = machine(home);
    expect((await gitSafety(context, home)).detail).toBe(
      [
        `ccx's folder ${configHome(context.ctx)} is in the git repository at ${real(home)}, ` +
          'which tracks 1 of its files: profiles/work/.credentials.json',
        `Claude's folder ${path.join(home, '.claude')} is in the git repository at ${real(home)}, ` +
          'which tracks 1 login file: .credentials.json',
      ].join('; '),
    );
  });

  it('names the first five files and counts the rest', async () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => `sessions/${name}/.claude.json`);
    const home = repoTracking(files.map((file) => `.claude-auto-switch/${file}`));
    expect((await gitSafety(machine(home))).detail).toContain(
      `tracks 7 of its files: ${files.slice(0, 5).join(', ')} and 2 more`,
    );
  });

  it('reads a list of tracked files longer than Node lets a command print by default', async () => {
    // Past 1 MiB of output Node stops the command, and the list goes unread.
    // Index entries alone, without files on disk, keep this quick.
    const home = repoTracking([]);
    mkdirSync(path.join(home, '.claude-auto-switch'));
    const blob = git(home, ['hash-object', '-w', '--stdin']).trim();
    const entries = Array.from(
      { length: 20_000 },
      (_, i) => `100644 ${blob}\t.claude-auto-switch/sessions/${String(i).padStart(40, '0')}/state.json`,
    );
    git(home, ['update-index', '--add', '--index-info'], `${entries.join('\n')}\n`);
    expect((await gitSafety(machine(home))).detail).toContain('which tracks 20000 of its files');
  });

  it('says a repository whose files git cannot list was not checked, once, instead of passing it', async () => {
    const home = repoTracking(['.claude-auto-switch/accounts.json', '.claude/settings.json']);
    writeFileSync(path.join(home, '.git', 'index'), 'not an index\n', 'utf8');
    // ccx's folder, ~/.claude and the working folder all lead to this one repository.
    expect(await gitSafety(machine(home), home)).toMatchObject({
      ok: true,
      note: true,
      detail: `could not check the git repository at ${real(home)}: git could not list its files`,
    });
  });

  it("tells files apart by case, so only ccx's own config.json is let through", async () => {
    // Index entries alone, so a filesystem that ignores case can hold both names.
    const home = repoTracking([]);
    mkdirSync(path.join(home, '.claude-auto-switch'));
    const blob = git(home, ['hash-object', '-w', '--stdin']).trim();
    const entries = ['CONFIG.JSON', 'Notes.json', 'config.json', 'notes.json'].map(
      (name) => `100644 ${blob}\t.claude-auto-switch/${name}`,
    );
    git(home, ['update-index', '--add', '--index-info'], `${entries.join('\n')}\n`);
    expect((await gitSafety(machine(home))).detail).toContain(
      'which tracks 3 of its files: CONFIG.JSON, Notes.json, notes.json',
    );
  });

  // Only Linux's filesystem holds two folders whose names differ only in case.
  it.runIf(process.platform === 'linux')(
    "asks about a profiles folder whose name differs from ccx's folder only in case",
    async () => {
      const home = repoTracking(['.CLAUDE-AUTO-SWITCH/work/.credentials.json']);
      const context = machine(home);
      context.config = { ...context.config, profilesDir: path.join(home, '.CLAUDE-AUTO-SWITCH') };
      expect((await gitSafety(context)).detail).toContain('tracks 1 of its files: work/.credentials.json');
    },
  );

  it('finds the repository of a home folder kept in git, past a ceiling that hides it', async () => {
    const home = repoTracking(['.claude-auto-switch/accounts.json']);
    const before = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = real(home);
    try {
      expect(await gitSafety(machine(home))).toMatchObject({ ok: false });
    } finally {
      if (before === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = before;
    }
  });

  it("asks about each folder's own repository while a git hook's variables point elsewhere", async () => {
    const other = repoTracking(['backup/.credentials.json']);
    const before = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(other, '.git');
    try {
      expect((await gitSafety(machine())).ok).toBe(true);
    } finally {
      if (before === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = before;
    }
  });

  // Windows will not delete the folder a process is in.
  it.skipIf(process.platform === 'win32')('still runs when the folder it was started in has been deleted', async () => {
    const gone = freshFolder();
    process.chdir(gone);
    rmSync(gone, { recursive: true });
    expect((await check(machine())).ok).toBe(true);
  });
});

describe('auditShells', () => {
  /** A plan whose files live in a fresh temporary folder, so no real profile is read. */
  function planIn(id: ShellPlan['id'], names: string[], over: Partial<ShellPlan> = {}): ShellPlan {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-docshim-'));
    const files = names.map((n) => path.join(dir, n));
    return {
      id,
      label: id,
      kind: names[0]?.endsWith('.ps1') ? 'powershell' : 'posix',
      state: 'use',
      files,
      retired: [],
      sweep: files,
      ...over,
    };
  }
  /** Not Windows, so the list holds only the shells given, on any host. */
  const posix = (lines?: string[]): CliContext => {
    const c = context(lines);
    c.ctx.platform = 'linux';
    return c;
  };
  const quietDeps = {
    gitTracked: () => null,
    resolveClaude: () => ({ bin: '/real/claude' }),
    checkBrowserPort: () => Promise.resolve(true),
    skipNetwork: true,
  };
  const shellCheck = (checks: ReturnType<typeof auditShells>, shell: string) => {
    const found = checks.find((c) => c.shell === shell);
    if (!found) throw new Error(`no check for ${shell}`);
    return found;
  };

  it('says, shell by shell, that `claude` goes through ccx', () => {
    const zsh = planIn('zsh', ['.zshrc']);
    const ps = planIn('powershell', ['profile.ps1'], { label: 'Windows PowerShell' });
    installShim(zsh.files[0] as string, 'posix');
    installShim(ps.files[0] as string, 'powershell');
    const checks = auditShells(posix(), { shellPlans: [zsh, ps] });
    expect(checks.map((c) => [c.label, c.ok, c.note ?? false])).toEqual([
      ['zsh', true, false],
      ['Windows PowerShell', true, false],
    ]);
    expect(shellCheck(checks, 'zsh').detail).toContain('goes through ccx');
  });

  it('FAILS a shell that skips ccx while another has it: one window works and the next does not', () => {
    const zsh = planIn('zsh', ['.zshrc']);
    const bash = planIn('bash', ['.bashrc']);
    installShim(zsh.files[0] as string, 'posix');
    const r = shellCheck(auditShells(posix(), { shellPlans: [zsh, bash] }), 'bash');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(bash.files[0]);
    expect(r.fix).toEqual(['ccx on']);
  });

  it('only suggests ccx on while no shell has it at all', () => {
    const checks = auditShells(posix(), { shellPlans: [planIn('zsh', ['.zshrc']), planIn('bash', ['.bashrc'])] });
    for (const c of checks) {
      expect(c.ok).toBe(true);
      expect(c.note).toBe(true);
      expect(c.detail).toContain('runs on its own');
      expect(c.fix).toEqual(['ccx on']);
    }
  });

  it('FAILS a shell set up in only some of the files it reads', () => {
    const bash = planIn('bash', ['.bashrc', '.bash_profile']);
    installShim(bash.files[0] as string, 'posix');
    const r = shellCheck(auditShells(posix(), { shellPlans: [bash] }), 'bash');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(bash.files[1]);
    expect(r.detail).not.toContain(bash.files[0]);
  });

  it('FAILS an outdated shim without the uninstall fallback, and ccx on upgrades it', () => {
    const ps = planIn('powershell', ['profile.ps1']);
    writeFileSync(
      ps.files[0] as string,
      '# >>> claude-auto-switch shim >>>\nfunction claude {\n    ccx run -- @args\n}\n# <<< claude-auto-switch shim <<<\n',
      'utf8',
    );
    expect(shellCheck(auditShells(posix(), { shellPlans: [ps] }), 'powershell').ok).toBe(false);
    expect(installShim(ps.files[0] as string, 'powershell')).toBe('installed');
    expect(shellCheck(auditShells(posix(), { shellPlans: [ps] }), 'powershell').ok).toBe(true);
  });

  it('FAILS a shell that also loads a copy from a file it should not be in', () => {
    const ps = planIn('powershell', ['profile.ps1']);
    const consoleOnly = path.join(path.dirname(ps.files[0] as string), 'Microsoft.PowerShell_profile.ps1');
    installShim(ps.files[0] as string, 'powershell');
    installShim(consoleOnly, 'powershell');
    const r = shellCheck(auditShells(posix(), { shellPlans: [{ ...ps, retired: [consoleOnly] }] }), 'powershell');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(consoleOnly);
    expect(r.fix).toEqual(['ccx on']);
  });

  it('names an execution policy that stops a shell, gives the command, and changes nothing', () => {
    const fix = 'powershell -NoProfile -Command Set-ExecutionPolicy -Scope CurrentUser RemoteSigned';
    const ps = planIn('powershell', ['profile.ps1'], {
      blocked: { detail: 'its execution policy is Restricted, so it runs neither its profile nor npm\'s ccx command', fix },
    });
    const r = shellCheck(auditShells(posix(), { shellPlans: [ps] }), 'powershell');
    expect(r.detail).toContain('Restricted');
    expect(r.fix).toEqual([fix]);
    expect(existsSync(ps.files[0] as string)).toBe(false);
  });

  it('gives no command where only an administrator can change the policy', () => {
    const ps = planIn('powershell', ['profile.ps1'], {
      blocked: { detail: 'its execution policy is Restricted; Group Policy sets it' },
    });
    const r = shellCheck(auditShells(posix(), { shellPlans: [ps] }), 'powershell');
    expect(r.detail).toContain('Group Policy');
    expect(r.fix).toBeUndefined();
  });

  it('lists a shell nobody uses as left alone, with the command that adds it', () => {
    const bash = planIn('bash', ['.bashrc'], { state: 'unused', why: 'nothing shows bash is used here' });
    const r = shellCheck(auditShells(posix(), { shellPlans: [bash] }), 'bash');
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('ccx on --shell bash');
    expect(r.fix).toBeUndefined();
  });

  it('leaves out a shell that is not installed', () => {
    expect(auditShells(posix(), { shellPlans: [planIn('pwsh', ['profile.ps1'], { state: 'absent' })] })).toEqual([]);
  });

  it('says cmd is not covered on Windows, since it has no profile', () => {
    const c = context();
    c.ctx.platform = 'win32';
    const r = shellCheck(auditShells(c, { shellPlans: [] }), 'cmd');
    expect(r.ok).toBe(true);
    expect(r.note).toBe(true);
    expect(r.detail).toContain('not covered');
    expect(auditShells(posix(), { shellPlans: [] })).toEqual([]);
  });

  it('prints each shell on its own line', async () => {
    const lines: string[] = [];
    const c = posix(lines);
    wireStatusline(c);
    const zsh = planIn('zsh', ['.zshrc']);
    installShim(zsh.files[0] as string, 'posix');
    const bash = planIn('bash', ['.bashrc'], { label: 'Git Bash' });
    await doctorCommand(c, { ...quietDeps, shellPlans: [zsh, bash] });
    const out = lines.join('\n');
    expect(out).toMatch(/zsh +`claude` goes through ccx/);
    expect(out).toMatch(/Git Bash +`claude` skips ccx/);
  });
});

describe('auditSharedHistory', () => {
  it('FAILS when the session history is a forked real directory', () => {
    const c = context();
    const sessionProjects = path.join(
      c.ctx.env!.CLAUDE_AUTO_SWITCH_HOME!,
      'session',
      'projects',
    );
    mkdirSync(sessionProjects, { recursive: true });
    const r = auditSharedHistory(c);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('FORKED');
  });

  it('is ok before any ccx session exists', () => {
    expect(auditSharedHistory(context()).ok).toBe(true);
  });
});

describe('auditCaps', () => {
  /** A config home with accounts, some capped and some with a refused login. */
  function withAccounts(
    ctxObj: CliContext,
    accounts: Array<{ name: string; capped?: boolean; refused?: boolean }>,
  ) {
    const home = (ctxObj.ctx.env as Record<string, string>).CLAUDE_AUTO_SWITCH_HOME as string;
    const registry = accounts.map((a) => {
      const dir = path.join(home, 'profiles', a.name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: { accessToken: `tok-${a.name}`, refreshToken: `refresh-${a.name}` },
        }),
        'utf8',
      );
      return { name: a.name, dir, priority: 0, enabled: true };
    });
    writeFileSync(path.join(home, 'accounts.json'), JSON.stringify({ accounts: registry }), 'utf8');

    const refused: Record<string, { at: number; detail: string }> = {};
    for (const a of accounts.filter((x) => x.refused)) {
      const dir = path.join(home, 'profiles', a.name);
      refused[credentialFileFingerprint(dir) ?? a.name] = { at: Date.now(), detail: 'invalid_grant' };
    }
    writeFileSync(path.join(home, 'dead-logins.json'), JSON.stringify({ refused }), 'utf8');

    // Built through the real ledger API rather than hand-written JSON: a cap
    // record has more shape than it looks, and inventing it produced a schema
    // error instead of a test.
    let ledger = loadLedger(ctxObj.ctx);
    for (const a of accounts.filter((x) => x.capped)) {
      ledger = markCapped(ledger, {
        account: a.name,
        now: Date.now(),
        resetAt: Date.now() + 60 * 60_000,
        reason: 'usage cap',
      });
    }
    updateLedger(ctxObj.ctx, () => ledger);
  }

  it('is ok with an empty ledger', () => {
    const r = auditCaps(context());
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('no accounts marked capped');
  });

  it('FAILS when every account you can actually use is capped', () => {
    // The live case that reported ok: two working accounts both capped, while
    // two profiles with refused logins made the total look healthy. Counting
    // enabled accounts instead of usable ones hid exactly the state this check
    // exists to catch.
    const c = context();
    withAccounts(c, [
      { name: 'second', capped: true },
      { name: 'phx', capped: true },
      { name: 'main', refused: true },
      { name: 'maxed', refused: true },
    ]);

    const r = auditCaps(c);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('every account you can actually use is capped');
    expect(r.detail).toContain('need signing in first: main, maxed');
    expect(r.fix?.join(' ')).toContain('ccx login main');
  });

  it('stays ok while a usable account is still free', () => {
    const c = context();
    withAccounts(c, [
      { name: 'second', capped: true },
      { name: 'phx' },
      { name: 'main', refused: true },
    ]);

    const r = auditCaps(c);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('capped: second');
  });

  it('does not claim everything is capped when nothing can be used at all', () => {
    // No usable account and no cap is a sign-in problem, which the accounts
    // check reports. Claiming a cap here would send someone to wait instead.
    const c = context();
    withAccounts(c, [{ name: 'main', refused: true, capped: true }]);

    const r = auditCaps(c);
    expect(r.ok).toBe(true);
  });
});

describe('doctorCommand', () => {
  const cleanDeps = {
    gitTracked: () => null,
    resolveClaude: () => ({ bin: '/real/claude' }),
    checkBrowserPort: () => Promise.resolve(true),
    shellPlans: [],
  };

  it('passes with a clean tracked-file list and a resolvable claude', async () => {
    const lines: string[] = [];
    const c = context(lines);
    wireStatusline(c);
    const code = await doctorCommand(c, cleanDeps);
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('everything is in order');
  });

  it('leaves a status line of your own alone, and says so', async () => {
    const lines: string[] = [];
    const c = context(lines);
    const file = settingsPath(c.ctx);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'starship' } }));

    const code = await doctorCommand(c, cleanDeps);
    expect(code).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('your own status line is in place');
    expect(out).toContain('ccx on');
    // And doctor only LOOKS. A checkup that quietly rewrote the settings it was
    // reporting on would be a far worse bug than the one it is reporting.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      statusLine: { type: 'command', command: 'starship' },
    });
  });

  it('FAILS when the settings file cannot be read as settings', async () => {
    // ccx refuses to write over a file it cannot parse, so the status line will
    // never appear until someone fixes the file. That is a real problem, not a
    // note, and the report has to say so rather than quietly staying silent.
    for (const contents of ['{ not json at all', '[1, 2, 3]']) {
      const lines: string[] = [];
      const c = context(lines);
      const file = settingsPath(c.ctx);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, contents, 'utf8');

      const code = await doctorCommand(c, cleanDeps);
      expect(code).toBe(1);
      const out = lines.join('\n');
      expect(out).toContain('could not be read as settings');
      expect(out).toContain('valid JSON object');
    }
  });

  it('mentions the status line when nothing on screen says ccx is running', async () => {
    // The shim is transparent, so an unwired status line means there is no
    // sign at all that account switching is happening. Worth saying, without
    // calling it a failure: it is a missing convenience, not a broken tool.
    const lines: string[] = [];
    const code = await doctorCommand(context(lines), cleanDeps);
    expect(code).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('status line');
    expect(out).toContain('ccx on');
  });

  it('reports the problem and how to fix it when something is wrong', async () => {
    const lines: string[] = [];
    const c = context(lines);
    const code = await doctorCommand(c, {
      ...cleanDeps,
      gitTracked: (folder) =>
        folder === configHome(c.ctx) ? { repo: folder, files: ['accounts.json'] } : null,
    });
    expect(code).toBe(1);
    const out = lines.join('\n');
    expect(out).toContain('1 problem found');
    expect(out).toContain('git safety'); // named in plain language
    expect(out).toContain('✗');
  });

  it('emits machine-readable output with --json', async () => {
    const lines: string[] = [];
    const ctx = { ...context(lines), json: true };
    const code = await doctorCommand(ctx, cleanDeps);
    expect(code).toBe(0);
    const payload = JSON.parse(lines.join('\n'));
    expect(payload.schemaVersion).toBe(1);
    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.checks)).toBe(true);
  });
});

describe('auditSharedLogins', () => {
  /** Give `name` a stored login whose refresh token is `token`. */
  function signIn(context: CliContext, name: string, token: string): void {
    const home = context.ctx.env?.CLAUDE_AUTO_SWITCH_HOME as string;
    const dir = path.join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: `at-${token}`, refreshToken: token } }),
      'utf8',
    );
    addAccount({ name, dir, enabled: true }, context.ctx);
  }

  it('passes when every account has its own login', () => {
    const c = context();
    signIn(c, 'one', 'refresh-one');
    signIn(c, 'two', 'refresh-two');
    expect(auditSharedLogins(c).ok).toBe(true);
  });

  it('fails, names both profiles, and says how to fix it when a login is shared', () => {
    const c = context();
    signIn(c, 'one', 'same-refresh-token');
    signIn(c, 'two', 'same-refresh-token');
    const r = auditSharedLogins(c);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('one');
    expect(r.detail).toContain('two');
    expect(r.fix).toEqual(['ccx login two']); // the first one keeps the login
  });

  it('never puts a token in the report', () => {
    const c = context();
    signIn(c, 'one', 'super-secret-refresh');
    signIn(c, 'two', 'super-secret-refresh');
    const r = auditSharedLogins(c);
    expect(JSON.stringify(r)).not.toContain('super-secret-refresh');
  });
});

describe('doctor on a machine nobody is at', () => {
  const serverDeps = {
    gitTracked: () => null,
    resolveClaude: () => ({ bin: '/real/claude' }),
    checkBrowserPort: () => Promise.resolve(false),
    shellPlans: [],
    headless: true,
  };

  it('explains how to sign in without a browser instead of offering to open one', async () => {
    const lines: string[] = [];
    const c = context(lines);
    c.json = true;
    await doctorCommand(c, { ...serverDeps, readCrontab: () => Promise.resolve('') });
    const report = JSON.parse(lines.join('\n')) as { checks: Array<{ name: string; detail: string }> };
    const browser = report.checks.find((check) => check.name === 'browser-debug-port');
    expect(browser?.detail).toContain('ccx login --host');
    expect(browser?.detail).not.toContain('opens a browser');
  });

  // Keepalive is cron's, so doctor brings it up only where cron exists.
  it.skipIf(process.platform === 'win32')('suggests keepalive when nothing renews idle logins', async () => {
    const lines: string[] = [];
    const c = context(lines);
    c.json = true;
    await doctorCommand(c, { ...serverDeps, readCrontab: () => Promise.resolve('0 3 * * * backup\n') });
    const report = JSON.parse(lines.join('\n')) as {
      checks: Array<{ name: string; ok: boolean; note?: boolean; fix?: string[] }>;
    };
    const keepalive = report.checks.find((check) => check.name === 'keepalive');
    expect(keepalive).toMatchObject({ ok: true, note: true, fix: ['ccx keepalive on'] });
  });

  const programs = { nodePath: '/usr/bin/node', cliPath: '/opt/ccx/dist/cli.js' };
  const keepaliveReport = async (crontab: string, exists: (file: string) => boolean = () => true) => {
    const lines: string[] = [];
    const c = context(lines);
    c.json = true;
    const installed = expectedKeepalive(c, programs).line;
    await doctorCommand(c, {
      ...serverDeps,
      keepalive: { ...programs, exists },
      readCrontab: () => Promise.resolve(crontab.replace('INSTALLED', installed)),
    });
    const report = JSON.parse(lines.join('\n')) as {
      checks: Array<{ name: string; note?: boolean; detail: string; fix?: string[] }>;
    };
    return report.checks.find((check) => check.name === 'keepalive');
  };

  it.skipIf(process.platform === 'win32')('is satisfied once keepalive runs this ccx', async () => {
    expect((await keepaliveReport('INSTALLED\n'))?.note).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('flags a keepalive line whose node or ccx has moved', async () => {
    const moved = await keepaliveReport('INSTALLED\n', (file) => file !== '/usr/bin/node');
    expect(moved).toMatchObject({ note: true, fix: ['ccx keepalive on'] });
    expect(moved?.detail).toContain('renews nothing');
    const other = await keepaliveReport("17 */4 * * * '/old/node' '/old/cli.js' usage >/dev/null 2>&1 # ccx keepalive\n");
    expect(other).toMatchObject({ note: true, fix: ['ccx keepalive on'] });
  });

  it.skipIf(process.platform === 'win32')('does not count a keepalive line that is commented out', async () => {
    const off = await keepaliveReport('# INSTALLED\n');
    expect(off?.detail).toContain('nothing renews idle logins');
  });

  it('does not bring up keepalive on a desktop', async () => {
    const lines: string[] = [];
    const c = context(lines);
    c.json = true;
    let asked = false;
    await doctorCommand(c, {
      ...serverDeps,
      headless: false,
      readCrontab: () => {
        asked = true;
        return Promise.resolve('');
      },
    });
    const report = JSON.parse(lines.join('\n')) as { checks: Array<{ name: string }> };
    expect(report.checks.some((check) => check.name === 'keepalive')).toBe(false);
    expect(asked).toBe(false);
  });
});

describe('doctor and a Claude Code npm install that has lost its program', () => {
  const prefix = path.win32.join('C:', 'nvm4w', 'nodejs');
  const folder = path.win32.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
  const platformProgram = path.win32.join(folder, 'node_modules', '@anthropic-ai', 'claude-code-win32-x64', 'claude.exe');
  const missing: BrokenNpmInstall = {
    folder,
    prefix,
    program: path.win32.join(folder, 'bin', 'claude.exe'),
    state: 'missing',
    platformProgram: null,
    version: '2.1.302',
    busy: false,
  };
  const shims = [path.win32.join(prefix, 'claude'), path.win32.join(prefix, 'claude.cmd')];

  function report(search: ClaudeSearch, fix = false, repairMemory?: RepairMemory) {
    const repairs: string[] = [];
    const lines: string[] = [];
    const c = context(lines);
    c.json = true;
    const run = doctorCommand(
      c,
      {
        gitTracked: () => null,
        findClaude: () => search,
        repairClaude: () => {
          repairs.push('repaired');
          return [];
        },
        checkBrowserPort: () => Promise.resolve(true),
        shellPlans: [],
        skipNetwork: true,
        ...(repairMemory ? { repairMemory } : {}),
      },
      { fix },
    );
    return run.then(() => {
      const checks = (JSON.parse(lines.join('\n')) as { checks: DoctorCheck[] }).checks;
      return { claude: checks.find((check) => check.name === 'real-claude'), repairs };
    });
  }

  it('names the install and the fix, and repairs nothing by itself', async () => {
    const { claude, repairs } = await report({ bin: null, prefixArgs: [], fromPlatformPackage: false, candidates: shims, broken: [missing] });
    expect(claude?.ok).toBe(false);
    expect(claude?.detail).toContain(folder);
    expect(claude?.detail).toContain('missing its program');
    expect(claude?.detail).toContain('an update ran while Claude was open');
    expect(claude?.detail).toContain('npm i -g @anthropic-ai/claude-code');
    expect(claude?.fix).toEqual(['ccx doctor --fix']);
    expect(repairs).toEqual([]);
  });

  it("says when ccx's last repair of the install did not work, while it is as that repair left it", async () => {
    const failed = { stamp: stampOf(missing, nodeRepairFs), version: '2.1.302', at: '2026-10-16T22:00:00.000Z', reason: 'npm stopped with exit code 1' };
    const memory: RepairMemory = { get: () => failed, set: () => {} };
    const search: ClaudeSearch = { bin: null, prefixArgs: [], fromPlatformPackage: false, candidates: shims, broken: [missing] };
    const { claude } = await report(search, false, memory);
    expect(claude?.detail).toContain('did not work: npm stopped with exit code 1');
    // Changed since, so that repair says nothing about it now.
    const changed: RepairMemory = { get: () => ({ ...failed, stamp: 'something else' }), set: () => {} };
    expect((await report(search, false, changed)).claude?.detail).not.toContain('did not work');
  });

  it('names a bin\\claude.exe cut short, with its fix, while Claude starts from the platform package', async () => {
    const { claude } = await report({
      bin: platformProgram,
      prefixArgs: [],
      fromPlatformPackage: true,
      candidates: shims,
      broken: [{ ...missing, state: 'cut-short', platformProgram }],
    });
    expect(claude).toMatchObject({ ok: true, note: true, fix: ['ccx doctor --fix'] });
    expect(claude?.detail).toContain('shorter than its own headers say');
  });

  it('reports a package folder that is gone the same way', async () => {
    const gone: BrokenNpmInstall = { ...missing, state: 'folder-missing', version: null };
    const { claude, repairs } = await report({ bin: null, prefixArgs: [], fromPlatformPackage: false, candidates: shims, broken: [gone] });
    expect(claude?.ok).toBe(false);
    expect(claude?.detail).toContain('the folder is not there');
    expect(claude?.fix).toEqual(['ccx doctor --fix']);
    expect(repairs).toEqual([]);
  });

  it('runs the repair with --fix', async () => {
    const { repairs } = await report({ bin: null, prefixArgs: [], fromPlatformPackage: false, candidates: shims, broken: [missing] }, true);
    expect(repairs).toEqual(['repaired']);
  });

  it('runs no repair with --fix when nothing is broken', async () => {
    const bin = path.win32.join(folder, 'bin', 'claude.exe');
    const { claude, repairs } = await report({ bin, prefixArgs: [], fromPlatformPackage: false, candidates: shims, broken: [] }, true);
    expect(claude).toMatchObject({ ok: true, detail: `resolved to ${bin}` });
    expect(repairs).toEqual([]);
  });

  it('still mentions a broken install while Claude starts from its platform package', async () => {
    const { claude } = await report({
      bin: platformProgram,
      prefixArgs: [],
      fromPlatformPackage: true,
      candidates: shims,
      broken: [{ ...missing, state: 'placeholder', platformProgram }],
    });
    expect(claude).toMatchObject({ ok: true, note: true, fix: ['ccx doctor --fix'] });
    expect(claude?.detail).toContain(platformProgram);
    expect(claude?.detail).toContain('only the placeholder');
  });
});

describe('logins saved cut short', () => {
  const deps = {
    gitTracked: () => null,
    resolveClaude: () => ({ bin: '/real/claude' }),
    checkBrowserPort: () => Promise.resolve(true),
    shellPlans: [],
  };
  /** A context whose `claude auth status` answers signed out, without running Claude. */
  function withClaude(lines: string[] = []): CliContext {
    return { ...context(lines), claude: { bin: process.execPath, prefixArgs: ['-e', 'console.log(JSON.stringify({ loggedIn: false }))'] } };
  }
  /** Register `name` with `stored` as its login and a working one kept before it. */
  function account(c: CliContext, name: string, stored: string): string {
    const home = c.ctx.env?.CLAUDE_AUTO_SWITCH_HOME as string;
    const dir = path.join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.credentials.json'), stored, 'utf8');
    writeFileSync(
      path.join(dir, '.credentials.prev.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: `at-${name}`, refreshToken: `rt-${name}` } }),
      'utf8',
    );
    addAccount({ name, dir, enabled: true }, c.ctx);
    return dir;
  }
  const cut = '{"claudeAiOauth":{"accessToken":"at-cut';
  const signedOut = JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '' } });
  const stored = (dir: string): string => readFileSync(path.join(dir, '.credentials.json'), 'utf8');

  it('are named in the report, with the fix', () => {
    const c = withClaude();
    account(c, 'one', cut);
    account(c, 'two', signedOut);
    const check = auditCutShortLogins(c);
    expect(check).toMatchObject({ ok: false, fix: ['ccx doctor --fix'] });
    expect(check?.detail).toContain('one');
    expect(check?.detail).not.toContain('two');
  });

  it('make the checkup fail, naming them and the fix', async () => {
    const lines: string[] = [];
    const c = withClaude(lines);
    const dir = account(c, 'one', cut);
    expect(await doctorCommand(c, deps)).toBe(1);
    expect(lines.join('\n')).toContain('saved cut short, so Claude cannot read them: one');
    expect(lines.join('\n')).toContain('ccx doctor --fix');
    expect(stored(dir)).toBe(cut);
  });

  it('are put back by --fix from the login kept before, and the report then has nothing to say', async () => {
    const lines: string[] = [];
    const c = withClaude(lines);
    const dir = account(c, 'one', cut);
    await doctorCommand(c, deps, { fix: true });
    expect(JSON.parse(stored(dir))).toEqual({ claudeAiOauth: { accessToken: 'at-one', refreshToken: 'rt-one' } });
    expect(lines.join('\n')).not.toContain('saved cut short');
  });

  it('are left to a running session that holds the account, which saves its own', () => {
    const c = withClaude();
    const dir = account(c, 'one', cut);
    takeLease('one', path.join(path.dirname(dir), 'a-session'), c.ctx);
    expect(restoreCutShortLogins(c)).toEqual([]);
    expect(stored(dir)).toBe(cut);
  });

  it('never include a login Claude signed out, which reads whole', () => {
    const c = withClaude();
    const dir = account(c, 'one', signedOut);
    expect(restoreCutShortLogins(c)).toEqual([]);
    expect(stored(dir)).toBe(signedOut);
    expect(auditCutShortLogins(c)).toBeNull();
  });
});
