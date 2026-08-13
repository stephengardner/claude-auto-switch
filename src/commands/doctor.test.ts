import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  auditGitSafety,
  auditShim,
  auditSharedHistory,
  auditSharedLogins,
  auditCaps,
  doctorCommand,
} from './doctor.js';
import { settingsPath } from '../statusline/settings-install.js';
import { addAccount } from '../accounts/registry.js';
import { installShim } from '../shell/install-shim.js';
import { loadConfig } from '../config/config.js';
import { credentialFileFingerprint } from '../accounts/credential-vault.js';
import { loadLedger, markCapped, saveLedger } from '../ledger/ledger.js';
import type { CliContext } from '../context.js';

function context(lines: string[] = []): CliContext {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-doc-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
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

describe('auditGitSafety', () => {
  it('passes when no secrets are tracked', () => {
    expect(auditGitSafety(['src/cli.ts', 'README.md', 'package.json']).ok).toBe(true);
  });

  it('fails when a credential or profile file is tracked', () => {
    expect(auditGitSafety(['accounts.json']).ok).toBe(false);
    expect(auditGitSafety(['ledger.json']).ok).toBe(false);
    expect(auditGitSafety(['profiles/work/.credentials.json']).ok).toBe(false);
  });
});

describe('auditShim', () => {
  const profileIn = (dir: string): string => path.join(dir, 'profile.ps1');

  it('reports ok when the current (fallback) shim is installed', () => {
    const p = profileIn(mkdtempSync(path.join(tmpdir(), 'cas-docshim-')));
    installShim(p, 'powershell');
    const r = auditShim(context(), { resolveShimProfile: () => p });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('runs through ccx');
  });

  it('FAILS on an outdated shim without the uninstall fallback', () => {
    const p = profileIn(mkdtempSync(path.join(tmpdir(), 'cas-docshim-')));
    writeFileSync(
      p,
      '# >>> claude-auto-switch shim >>>\nfunction claude {\n    ccx run -- @args\n}\n# <<< claude-auto-switch shim <<<\n',
      'utf8',
    );
    expect(auditShim(context(), { resolveShimProfile: () => p }).ok).toBe(false);
    // And `ccx on` upgrades it in place.
    expect(installShim(p, 'powershell')).toBe('installed');
    expect(auditShim(context(), { resolveShimProfile: () => p }).ok).toBe(true);
  });

  it('treats a missing shim as informational, not a failure', () => {
    const p = profileIn(mkdtempSync(path.join(tmpdir(), 'cas-docshim-')));
    const r = auditShim(context(), { resolveShimProfile: () => p });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('not installed');
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
    saveLedger(ledger, ctxObj.ctx);
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
    gitTrackedFiles: () => ['src/cli.ts'],
    resolveClaude: () => ({ bin: '/real/claude' }),
    checkBrowserPort: () => Promise.resolve(true),
    resolveShimProfile: () => null,
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
    const code = await doctorCommand(context(lines), {
      ...cleanDeps,
      gitTrackedFiles: () => ['accounts.json'],
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
