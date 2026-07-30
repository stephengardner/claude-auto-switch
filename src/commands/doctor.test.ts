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
import { addAccount } from '../accounts/registry.js';
import { installShim } from '../shell/install-shim.js';
import { loadConfig } from '../config/config.js';
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
  it('is ok with an empty ledger', () => {
    const r = auditCaps(context());
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('no accounts marked capped');
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
    const code = await doctorCommand(context(lines), cleanDeps);
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('everything is in order');
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
