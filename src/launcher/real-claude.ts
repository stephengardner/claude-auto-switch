import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ClaudeInvoker } from '../invoker.js';
import { RealClaudeError } from '../util/errors.js';

export interface ResolveDeps {
  config?: { realClaudePath?: string | null };
  /** Returns candidate absolute paths for `claude` (like `where`/`which -a`). */
  findCandidates?: () => string[];
  /** Predicate marking a candidate as our own shim, to be skipped. */
  isShim?: (candidate: string) => boolean;
  platform?: NodeJS.Platform;
}

/**
 * Resolve the REAL claude launcher to an absolute path and return it as an
 * invoker. On Windows this resolves to the actual `.exe` (not the `.cmd` shim,
 * which node-pty cannot launch). Invoking by absolute path (never the bare name)
 * is what stops the transparent shim from calling itself. An explicit
 * `config.realClaudePath` always wins.
 */
export function resolveRealClaude(deps: ResolveDeps = {}): ClaudeInvoker {
  const configured = deps.config?.realClaudePath;
  if (configured) return { bin: configured, prefixArgs: [] };

  const platform = deps.platform ?? process.platform;
  const findCandidates = deps.findCandidates ?? (() => defaultFindCandidates(platform));
  const isShim = deps.isShim ?? defaultIsShim;

  const candidates = findCandidates().filter((candidate) => !isShim(candidate));
  const real = pickRealClaude(candidates, platform);
  if (!real) {
    throw new RealClaudeError(
      'could not resolve the real claude binary; set realClaudePath in config or ensure Claude Code is installed',
    );
  }
  return { bin: real, prefixArgs: [] };
}

/**
 * Choose the launchable binary. On Windows, prefer a real `.exe` (node-pty and
 * CreateProcess cannot run a `.cmd`/`.ps1`/shell shim), deriving it from the
 * `.cmd` shim when needed.
 */
function pickRealClaude(candidates: string[], platform: NodeJS.Platform): string | undefined {
  if (candidates.length === 0) return undefined;
  if (platform !== 'win32') return candidates[0];

  const directExe = candidates.find((c) => /\.exe$/i.test(c));
  if (directExe) return directExe;

  // Prefer the standard npm install layout (a real file) BEFORE trusting text
  // scraped from a .cmd shim.
  for (const candidate of candidates) {
    const guess = path.join(
      path.dirname(candidate),
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    );
    if (existsSync(guess)) return guess;
  }
  for (const candidate of candidates) {
    const derived = deriveExeFromCmd(candidate);
    if (derived) return derived;
  }
  // Never fall back to a non-.exe on Windows: node-pty cannot launch a .cmd
  // (and routing a .cmd through cmd.exe is an argument-escaping hazard). Failing
  // loudly is safer than executing whatever `where claude` printed first.
  return undefined;
}

/**
 * Read the `.exe` path out of an npm `.cmd` shim, resolved next to the shim.
 * The derived path is constrained to the shim's own directory tree so a crafted
 * or hijacked shim cannot point ccx at an arbitrary executable elsewhere.
 */
function deriveExeFromCmd(cmdPath: string): string | null {
  if (!/\.cmd$/i.test(cmdPath) || !existsSync(cmdPath)) return null;
  try {
    const content = readFileSync(cmdPath, 'utf8');
    const match = content.match(/dp0%?\\?([^"\r\n%]*?\.exe)/i);
    const raw = match?.[1];
    if (!raw || raw.includes('..') || path.isAbsolute(raw)) return null;
    const dir = path.resolve(path.dirname(cmdPath));
    const exe = path.resolve(dir, raw.replace(/^[\\/]/, ''));
    // Reject anything that escapes the shim directory.
    if (exe !== dir && !exe.startsWith(dir + path.sep)) return null;
    return existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

/** Ask the OS where `claude` lives, keeping only paths that still exist. */
function defaultFindCandidates(platform: NodeJS.Platform): string[] {
  const cmd = platform === 'win32' ? 'where' : 'which';
  const args = platform === 'win32' ? ['claude'] : ['-a', 'claude'];
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8' });
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && existsSync(line));
  } catch {
    return [];
  }
}

/**
 * Detect our own shim so it is never selected. The shim is normally a shell
 * function (not a PATH file), so this defaults to false in practice; it guards
 * the rare case a shim file lands on PATH.
 */
function defaultIsShim(candidate: string): boolean {
  return /claude-auto-switch|[\\/]ccx(\.|$)/i.test(candidate);
}
