import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installShim, uninstallShim, isShimInstalled, shimBlock } from './install-shim.js';

function profile(content?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-ps-'));
  const p = path.join(dir, 'profile');
  if (content !== undefined) writeFileSync(p, content, 'utf8');
  return p;
}

describe('shimBlock', () => {
  it('emits a PowerShell function', () => {
    expect(shimBlock('powershell')).toContain('function claude {');
    expect(shimBlock('powershell')).toContain('ccx run -- @args');
  });

  it('emits a POSIX function', () => {
    expect(shimBlock('posix')).toContain('claude() {');
    expect(shimBlock('posix')).toContain('ccx run -- "$@"');
  });
});

describe('shim installer', () => {
  it('installs into a fresh (missing) profile', () => {
    const p = profile();
    expect(installShim(p, 'powershell')).toBe('installed');
    expect(isShimInstalled(p)).toBe(true);
    expect(readFileSync(p, 'utf8')).toContain('function claude');
  });

  it('installs a POSIX shim', () => {
    const p = profile();
    installShim(p, 'posix');
    expect(readFileSync(p, 'utf8')).toContain('claude() {');
  });

  it('is idempotent (never inserts twice)', () => {
    const p = profile();
    installShim(p, 'powershell');
    expect(installShim(p, 'powershell')).toBe('already-present');
    // Exactly ONE shim block exists after repeated installs.
    expect(readFileSync(p, 'utf8').split('>>> claude-auto-switch shim >>>').length - 1).toBe(1);
  });

  it('falls back to the real claude when ccx is not on PATH', () => {
    // Uninstalling ccx without `ccx off` must never leave `claude` broken.
    expect(shimBlock('powershell')).toContain('Get-Command ccx -ErrorAction SilentlyContinue');
    expect(shimBlock('powershell')).toContain('$real.Source @args');
    expect(shimBlock('posix')).toContain('command -v ccx');
    expect(shimBlock('posix')).toContain('command claude "$@"');
  });

  it('preserves existing content and writes a backup', () => {
    const p = profile('alias ll=ls -la\n');
    installShim(p, 'posix');
    const content = readFileSync(p, 'utf8');
    expect(content).toContain('alias ll');
    expect(content).toContain('claude() {');
    expect(existsSync(`${p}.cas-backup`)).toBe(true);
  });

  it('removes cleanly, leaving other content', () => {
    const p = profile('alias ll=ls -la\n');
    installShim(p, 'posix');
    expect(uninstallShim(p)).toBe('removed');
    expect(isShimInstalled(p)).toBe(false);
    expect(readFileSync(p, 'utf8')).toContain('alias ll');
  });

  it('reports not-present when removing from a profile without the shim', () => {
    expect(uninstallShim(profile('# nothing here\n'))).toBe('not-present');
  });
});
