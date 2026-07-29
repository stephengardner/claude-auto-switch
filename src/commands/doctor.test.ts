import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  auditGitSafety,
  auditShim,
  auditSharedHistory,
  auditCaps,
  doctorCommand,
} from './doctor.js';
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
    expect(r.detail).toContain('safe fallback');
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
    expect(lines.join('\n')).toContain('all checks passed');
  });

  it('fails and reports when secrets are tracked', async () => {
    const lines: string[] = [];
    const code = await doctorCommand(context(lines), {
      ...cleanDeps,
      gitTrackedFiles: () => ['accounts.json'],
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('FAIL');
  });
});
