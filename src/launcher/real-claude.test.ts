import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveRealClaude, whereItIsUsuallyInstalled } from './real-claude.js';
import { RealClaudeError } from '../util/errors.js';


/** Put an environment variable back exactly as it was, absent included. */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

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

describe('finding claude when PATH does not know about it', () => {
  // The reported failure on a fresh machine: Claude IS installed and runs in
  // the operator's own shell, but the installer put its directory on a PATH
  // this process never inherited, so `where claude` found nothing and ccx said
  // the binary did not exist.

  it('looks where Claude Code actually installs itself', () => {
    const windows = whereItIsUsuallyInstalled('win32');
    // The native installer, the local install `claude migrate-installer`
    // leaves behind, and both npm global layouts.
    expect(windows.some((p) => p.includes(path.join('.local', 'bin')))).toBe(true);
    expect(windows.some((p) => p.includes(path.join('.claude', 'local')))).toBe(true);
    expect(windows.some((p) => p.includes(path.join('npm', 'node_modules')))).toBe(true);
    expect(windows.every((p) => p.endsWith('.exe'))).toBe(true);

    const posix = whereItIsUsuallyInstalled('linux');
    expect(posix).toContain('/usr/local/bin/claude');
    expect(posix.some((p) => p.includes('homebrew'))).toBe(true);
    expect(posix.every((p) => !p.endsWith('.exe'))).toBe(true);
  });

  it('finds a REAL install through the real search when PATH knows nothing', () => {
    // Only onPath is stubbed, so the known-location search, the launchability
    // filter and the pick all run for real. Injecting findCandidates instead
    // would replace the very thing under test, leaving a test that passes
    // whether the fallback exists or not.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-home-'));
    const isWindows = process.platform === 'win32';
    const binDir = path.join(home, '.local', 'bin');
    mkdirSync(binDir, { recursive: true });
    const installed = path.join(binDir, isWindows ? 'claude.exe' : 'claude');
    writeFileSync(installed, 'binary');
    if (!isWindows) chmodSync(installed, 0o755);

    const previous = { home: process.env.HOME, profile: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const claude = resolveRealClaude({
        platform: process.platform,
        onPath: () => [], // this machine's PATH does not mention claude
      });
      expect(claude.bin).toBe(installed);
    } finally {
      // Deleted rather than assigned when there was nothing there: assigning
      // undefined stores the STRING "undefined", which is not absence, and
      // leaks into whatever runs next.
      restoreEnv('HOME', previous.home);
      restoreEnv('USERPROFILE', previous.profile);
    }
  });

  it('steps over something unlaunchable to reach the real install', () => {
    // Existing is not enough: a DIRECTORY named claude, or a file without the
    // executable bit, would otherwise be picked and hide a working install.
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-unlaunchable-'));
    const decoy = path.join(dir, 'claude');
    mkdirSync(decoy); // a directory, not a program
    const real = path.join(dir, 'real-claude');
    writeFileSync(real, 'binary');
    if (process.platform !== 'win32') chmodSync(real, 0o755);

    const claude = resolveRealClaude({
      platform: process.platform === 'win32' ? 'linux' : process.platform,
      onPath: () => [decoy, real],
    });
    expect(claude.bin).toBe(real);
  });

  it('says where it looked, and how to fix it, when there is nothing to find', () => {
    // The old message named a config key and stopped, which reads as "you have
    // not installed Claude" to someone who plainly has.
    let thrown: Error | null = null;
    try {
      resolveRealClaude({ platform: 'win32', findCandidates: () => [] });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeInstanceOf(RealClaudeError);
    expect(thrown?.message).toContain('looked on PATH, and in:');
    expect(thrown?.message).toContain('.local');
    expect(thrown?.message).toContain('realClaudePath');
    expect(thrown?.message).toContain('CAS_REAL_CLAUDE_PATH');
  });
});
