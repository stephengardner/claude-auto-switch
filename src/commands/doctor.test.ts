import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditGitSafety, doctorCommand } from './doctor.js';
import { loadConfig } from '../config/config.js';
import type { CliContext } from '../context.js';

function context(lines: string[]): CliContext {
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: mkdtempSync(path.join(tmpdir(), 'cas-doc-')) } };
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

describe('doctorCommand', () => {
  it('passes with a clean tracked-file list and a resolvable claude', async () => {
    const lines: string[] = [];
    const code = await doctorCommand(context(lines), {
      gitTrackedFiles: () => ['src/cli.ts'],
      resolveClaude: () => ({ bin: '/real/claude' }),
      checkBrowserPort: () => Promise.resolve(true),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('all checks passed');
  });

  it('fails and reports when secrets are tracked', async () => {
    const lines: string[] = [];
    const code = await doctorCommand(context(lines), {
      gitTrackedFiles: () => ['accounts.json'],
      resolveClaude: () => ({ bin: '/real/claude' }),
      checkBrowserPort: () => Promise.resolve(false),
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('FAIL');
  });
});
