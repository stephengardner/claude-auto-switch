import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const MARKER_START = '# >>> claude-auto-switch shim >>>';
const MARKER_END = '# <<< claude-auto-switch shim <<<';

export type ShellKind = 'powershell' | 'posix';

/**
 * The marker-delimited shim block for the given shell. `#` comments work in
 * both. The function falls back to the REAL claude when ccx is not on PATH, so
 * uninstalling ccx (without running `ccx off` first) never breaks `claude`.
 */
export function shimBlock(shell: ShellKind): string {
  const fn =
    shell === 'powershell'
      ? [
          'function claude {',
          '    if (Get-Command ccx -ErrorAction SilentlyContinue) {',
          '        ccx run -- @args',
          '    }',
          '    else {',
          '        $real = Get-Command claude -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1',
          '        if ($real) { & $real.Source @args }',
          '        else { Write-Error "claude not found on PATH" }',
          '    }',
          '}',
        ]
      : [
          'claude() {',
          '    if command -v ccx >/dev/null 2>&1; then',
          '        ccx run -- "$@"',
          '    else',
          '        command claude "$@"',
          '    fi',
          '}',
        ];
  return [MARKER_START, ...fn, MARKER_END].join('\n');
}

export function isShimInstalled(profilePath: string): boolean {
  return existsSync(profilePath) && readFileSync(profilePath, 'utf8').includes(MARKER_START);
}

/** True when the installed shim has the falls-back-to-real-claude safety net. */
export function shimHasFallback(profilePath: string): boolean {
  if (!isShimInstalled(profilePath)) return false;
  const text = readFileSync(profilePath, 'utf8');
  return text.includes('Get-Command ccx') || text.includes('command -v ccx');
}

/**
 * Install the shim block idempotently, backing up an existing profile first.
 * An installed but OUTDATED block (no uninstall fallback) is upgraded in place.
 */
export function installShim(profilePath: string, shell: ShellKind): 'installed' | 'already-present' {
  if (isShimInstalled(profilePath)) {
    if (shimHasFallback(profilePath)) return 'already-present';
    uninstallShim(profilePath); // outdated block: replace with the current one
  }

  mkdirSync(path.dirname(profilePath), { recursive: true });
  const existing = existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : '';
  if (existsSync(profilePath)) copyFileSync(profilePath, `${profilePath}.cas-backup`);

  const block = shimBlock(shell);
  const next = existing.trim().length > 0 ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`;
  writeFileSync(profilePath, next, 'utf8');
  return 'installed';
}

/** Remove the shim block, leaving any other profile content intact. */
export function uninstallShim(profilePath: string): 'removed' | 'not-present' {
  if (!isShimInstalled(profilePath)) return 'not-present';

  const lines = readFileSync(profilePath, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes(MARKER_START));
  const end = lines.findIndex((l) => l.includes(MARKER_END));
  if (start === -1 || end === -1 || end < start) return 'not-present';

  const kept = [...lines.slice(0, start), ...lines.slice(end + 1)];
  const cleaned = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '\n');
  writeFileSync(profilePath, cleaned, 'utf8');
  return 'removed';
}
