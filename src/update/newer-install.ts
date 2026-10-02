import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Whether a newer ccx has been installed where this one runs from.
 *
 * A ccx session runs for hours or days, and an update installed meanwhile used
 * to reach it only when someone closed it and started it again. Each session
 * now looks, and moves itself to the newer one at a safe moment (see
 * session.ts): when it is relaunching Claude anyway, or when Claude has been
 * idle for a little while.
 */

/** The package this code is running from: dist/update/ (or src/update/) is two levels down. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function versionAt(root: string): string | null {
  try {
    const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/** Read once, when this module loads: what is running, whatever is on disk later. */
const RUNNING = versionAt(ROOT);

let canonical: string | null | undefined;
/**
 * The install the `ccx` command runs, which is where updates land: usually the
 * one this process runs from, but not for a session started from a copy
 * elsewhere. Only asked by an installed ccx; a development checkout follows
 * nothing but itself, so a test run can never hand a session to the real one.
 */
function canonicalRoot(): string | null {
  if (canonical !== undefined) return canonical;
  canonical = null;
  if (!ROOT.split(/[\\/]/).includes('node_modules')) return canonical;
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const found = spawnSync(finder, ['ccx'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
    });
    const first = (found.stdout ?? '')
      .split(/\r?\n/)
      .find((l) => l.trim() !== '')
      ?.trim();
    if (!first) return canonical;
    // npm's Windows commands sit beside node_modules; elsewhere `ccx` links to dist/cli.js.
    const root =
      process.platform === 'win32'
        ? path.join(path.dirname(first), 'node_modules', 'claude-auto-switch')
        : path.resolve(path.dirname(realpathSync(first)), '..');
    if (existsSync(path.join(root, 'package.json'))) canonical = root;
  } catch {
    /* no ccx on PATH: follow this install only */
  }
  return canonical;
}

/** Whether `a` is a later release than `b` (major.minor.patch, numerically). */
export function isLaterVersion(a: string, b: string): boolean {
  const parts = (v: string): number[] =>
    v
      .split(/[.-]/)
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

export interface NewerInstall {
  version: string;
  /** Its entry point, to run with node. */
  cli: string;
}

/**
 * The newer ccx installed where this one runs from, once it is ready to take
 * over: a later version, its entry point in place, and its package untouched
 * for `settleMs`, so an install still being written is never started.
 */
export function newerInstall(
  options: { root?: string; running?: string | null; now?: number; settleMs?: number } = {},
): NewerInstall | null {
  const running = options.running === undefined ? RUNNING : options.running;
  if (!running) return null;
  const roots = options.root
    ? [options.root]
    : [ROOT, canonicalRoot()].filter((r, i, all): r is string => !!r && all.indexOf(r) === i);
  for (const root of roots) {
    const found = readyAt(root, running, options.now ?? Date.now(), options.settleMs ?? 15_000);
    if (found) return found;
  }
  return null;
}

function readyAt(
  root: string,
  running: string,
  now: number,
  settleMs: number,
): NewerInstall | null {
  try {
    if (now - statSync(path.join(root, 'package.json')).mtimeMs < settleMs) return null;
  } catch {
    return null;
  }
  const version = versionAt(root);
  const cli = path.join(root, 'dist', 'cli.js');
  if (!version || !isLaterVersion(version, running) || !existsSync(cli)) return null;
  return { version, cli };
}

/** The version running in this process. */
export function runningVersion(): string | null {
  return RUNNING;
}
