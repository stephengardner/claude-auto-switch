import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveRealClaude } from './real-claude.js';
import { RealClaudeError } from '../util/errors.js';

describe('resolveRealClaude', () => {
  it('uses the configured realClaudePath when set', () => {
    const invoker = resolveRealClaude({ config: { realClaudePath: '/opt/claude' } });
    expect(invoker.bin).toBe('/opt/claude');
    expect(invoker.prefixArgs).toEqual([]);
  });

  it('picks the real binary and skips an injected shim candidate (posix)', () => {
    const invoker = resolveRealClaude({
      platform: 'linux',
      findCandidates: () => ['/usr/local/bin/claude-shim', '/usr/local/bin/claude'],
      isShim: (c) => c.includes('shim'),
    });
    expect(invoker.bin).toBe('/usr/local/bin/claude');
  });

  it('excludes our own shim via the default detector (posix)', () => {
    const invoker = resolveRealClaude({
      platform: 'linux',
      findCandidates: () => ['/x/ccx', '/x/claude'],
    });
    expect(invoker.bin).toBe('/x/claude');
  });

  it('throws when no real candidate exists', () => {
    expect(() => resolveRealClaude({ findCandidates: () => [], isShim: () => false })).toThrow(
      RealClaudeError,
    );
  });

  it('refuses a bare .cmd on Windows (node-pty cannot launch it)', () => {
    // A .cmd with no resolvable real .exe must throw, never be returned.
    expect(() =>
      resolveRealClaude({ platform: 'win32', findCandidates: () => ['C:/x/claude.cmd'] }),
    ).toThrow(RealClaudeError);
  });

  it('derives the real .exe a Windows .cmd shim points at (node-pty needs the exe)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-exe-'));
    const cmd = path.join(dir, 'claude.cmd');
    writeFileSync(cmd, '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\n');
    const binDir = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
    mkdirSync(binDir, { recursive: true });
    const exe = path.join(binDir, 'claude.exe');
    writeFileSync(exe, '');
    const invoker = resolveRealClaude({ findCandidates: () => [cmd], platform: 'win32' });
    expect(invoker.bin).toBe(exe);
  });
});
