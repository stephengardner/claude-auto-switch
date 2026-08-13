import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ClaudeInvoker } from '../invoker.js';
import { RealClaudeError } from '../util/errors.js';

export interface ResolveDeps {
  config?: { realClaudePath?: string | null };
  /** Returns candidate absolute paths for `claude` (like `where`/`which -a`). */
  findCandidates?: () => string[];
  /**
   * Just the PATH lookup, so a test can simulate a machine where PATH knows
   * nothing while still exercising the real search of known locations. Without
   * this seam the only way to test discovery is to replace all of it, which
   * leaves a test that passes whether the discovery exists or not.
   */
  onPath?: () => string[];
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
  const findCandidates =
    deps.findCandidates ?? (() => defaultFindCandidates(platform, deps.onPath));
  const isShim = deps.isShim ?? defaultIsShim;

  const candidates = findCandidates().filter((candidate) => !isShim(candidate));
  const real = pickRealClaude(candidates, platform);
  if (!real) throw new RealClaudeError(cannotFindClaude(candidates, platform));
  return { bin: real, prefixArgs: [] };
}

/**
 * Say what was actually looked for, and what to do about it.
 *
 * The old message named a config key and stopped there, which reads as "you
 * have not installed Claude" to someone who plainly has. The two real causes
 * are a PATH this process never inherited and an install somewhere unusual,
 * and both are acted on differently.
 */
export function cannotFindClaude(candidates: string[], platform: NodeJS.Platform): string {
  const looked = whereItIsUsuallyInstalled(platform);
  const found = candidates.length > 0;
  const lines = [
    found
      ? `found claude at ${candidates.join(', ')}, but none of them can be launched directly` +
        (platform === 'win32' ? ' (Windows needs the real .exe, not a .cmd shim)' : '')
      : 'could not find the claude binary, on PATH or where it is normally installed',
    '',
    'looked on PATH, and in:',
    ...looked.map((p) => `  ${p}`),
    '',
    'if it is somewhere else, point ccx straight at it, once:',
    '  set realClaudePath in ~/.claude-auto-switch/config.json',
    '  or set CAS_REAL_CLAUDE_PATH in the environment',
  ];
  return lines.join('\n');
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

/**
 * Ask the OS where `claude` lives, then look where it is normally installed.
 *
 * PATH alone was not enough, and the way it fails is confusing: Claude is
 * installed, the operator can run it in their own shell, and ccx says it does
 * not exist. That happens whenever the installer added a directory to PATH
 * that this process never inherited, which is the ordinary case for a shell
 * (or an editor) started before the install, and for anything launched from a
 * process with a frozen environment.
 *
 * So a miss on PATH is not an answer, it is a reason to go and look.
 */
export function defaultFindCandidates(
  platform: NodeJS.Platform,
  fromPath: () => string[] = () => onPath(platform),
): string[] {
  return [...fromPath(), ...whereItIsUsuallyInstalled(platform)].filter((candidate) =>
    canBeLaunched(candidate, platform),
  );
}

/**
 * Is this something we could actually run?
 *
 * Existing is not enough. A directory can be named `claude`, and on POSIX a
 * file can exist without the executable bit. Either would be taken as the
 * answer, and since the first candidate wins, an unusable one hides a working
 * install further down the list. Failing to find Claude at all is a better
 * outcome than that: it says so, where this would report a launch failure
 * nobody could explain.
 */
function canBeLaunched(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (platform === 'win32') return true; // no executable bit to consult
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(platform: NodeJS.Platform): string[] {
  const cmd = platform === 'win32' ? 'where' : 'which';
  const args = platform === 'win32' ? ['claude'] : ['-a', 'claude'];
  try {
    // stderr is silenced deliberately. Finding nothing here is normal now that
    // the known locations are searched too, and `where` announces a miss with
    // "INFO: could not find files for the given patterns", which landed in the
    // operator's terminal looking like a fault.
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * The places Claude Code actually installs itself.
 *
 * Listed rather than guessed at: the native installer, the local install that
 * `claude migrate-installer` produces, and the two npm global layouts. An
 * absent one costs a stat, and a present one turns "could not resolve the real
 * claude binary" into a session that simply starts.
 */
export function whereItIsUsuallyInstalled(platform: NodeJS.Platform): string[] {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const npmPackage = path.join('node_modules', '@anthropic-ai', 'claude-code', 'bin');

  if (platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    return [
      path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(localAppData, 'Programs', 'claude', 'claude.exe'),
      path.join(home, '.claude', 'local', 'claude.exe'),
      path.join(appData, 'npm', npmPackage, 'claude.exe'),
      path.join(programFiles, 'nodejs', npmPackage, 'claude.exe'),
      path.join(home, '.bun', 'bin', 'claude.exe'),
    ];
  }

  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(home, '.bun', 'bin', 'claude'),
    path.join('/usr/local/lib', npmPackage, 'claude'),
  ];
}

/**
 * Detect our own shim so it is never selected. The shim is normally a shell
 * function (not a PATH file), so this defaults to false in practice; it guards
 * the rare case a shim file lands on PATH.
 */
function defaultIsShim(candidate: string): boolean {
  return /claude-auto-switch|[\\/]ccx(\.|$)/i.test(candidate);
}
