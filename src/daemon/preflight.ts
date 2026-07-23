import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCapture } from '../util/exec.js';
import { parseAuthStatus } from '../health/auth-status.js';
import { invokerArgs, type ClaudeInvoker } from '../invoker.js';

/**
 * How account credentials behave on this machine:
 * - `isolated`: a fresh CLAUDE_CONFIG_DIR is logged out, so config-dir rotation
 *   (the junction) isolates accounts. True on Windows and Linux.
 * - `shared`: a fresh CLAUDE_CONFIG_DIR still reports logged in, so credentials
 *   come from a shared store (the macOS Keychain). Config-dir rotation will NOT
 *   isolate accounts; use CLAUDE_CODE_OAUTH_TOKEN rotation instead.
 */
export type IsolationMode = 'isolated' | 'shared';

export interface PreflightDeps {
  /** Whether a brand-new, empty config dir reports logged in. */
  probeEmptyDirLoggedIn: () => boolean;
}

/**
 * Pure decision: if an empty config dir is still logged in, credentials are
 * shared (Keychain); otherwise they are per-dir and isolation holds.
 */
export function classifyIsolation(deps: PreflightDeps): IsolationMode {
  return deps.probeEmptyDirLoggedIn() ? 'shared' : 'isolated';
}

/** Recommended rotation mechanism for a given isolation mode. */
export function recommendedMechanism(mode: IsolationMode): 'junction' | 'oauth-token' {
  return mode === 'isolated' ? 'junction' : 'oauth-token';
}

/**
 * Real detector: run `claude auth status` against a throwaway empty config dir
 * and report whether credentials are per-dir (isolated) or shared. No model
 * tokens are spent. This is how the tool verifies its assumptions on the actual
 * machine instead of guessing per-OS.
 */
export async function detectIsolation(claude: ClaudeInvoker): Promise<IsolationMode> {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-preflight-'));
  const { stdout } = await runCapture(claude.bin, invokerArgs(claude, ['auth', 'status']), {
    env: { CLAUDE_CONFIG_DIR: dir },
  });
  let loggedIn = false;
  try {
    loggedIn = parseAuthStatus(stdout).loggedIn;
  } catch {
    loggedIn = false;
  }
  return classifyIsolation({ probeEmptyDirLoggedIn: () => loggedIn });
}
