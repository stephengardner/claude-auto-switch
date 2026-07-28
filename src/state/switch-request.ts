import { rmSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { configHome, type PathCtx } from '../config/paths.js';
import { readJsonFile, writeJsonFile } from '../util/fs-json.js';

/**
 * A pending request for a RUNNING session to switch accounts in place. The
 * dashboard (Enter) and `ccx use` write it; the live `ccx run` session polls it
 * and, when it can honor it, swaps credentials and resumes the same conversation
 * on the requested account. File-based IPC, same pattern as the events log.
 */
/**
 * `mode` decides HOW a running session honors the switch:
 * - 'seamless' (default): swap the credential file under the running process; it
 *   re-reads within ~30s (its cache TTL), so the SAME session moves to the new
 *   account with no restart and nothing lost.
 * - 'restart': end the process and relaunch `claude --continue` on the new
 *   account (instant, but reloads the TUI and loses live state).
 */
const SwitchRequestSchema = z.object({
  account: z.string(),
  at: z.number(),
  mode: z.enum(['seamless', 'restart']).optional(),
});
export type SwitchRequest = z.infer<typeof SwitchRequestSchema>;
export type SwitchMode = 'seamless' | 'restart';

const FILENAME = 'switch-request.json';

function switchRequestPath(c: PathCtx = {}): string {
  return path.join(configHome(c), FILENAME);
}

/** Ask a running session to switch to `account` (seamless by default). */
export function writeSwitchRequest(
  account: string,
  at: number,
  mode: SwitchMode = 'seamless',
  c: PathCtx = {},
): void {
  writeJsonFile(switchRequestPath(c), { account, at, mode });
}

/** The pending request, or null. A malformed file is ignored (never crashes a live session). */
export function readSwitchRequest(c: PathCtx = {}): SwitchRequest | null {
  try {
    return readJsonFile(switchRequestPath(c), SwitchRequestSchema) ?? null;
  } catch {
    return null;
  }
}

/** Remove the pending request (best effort). */
export function clearSwitchRequest(c: PathCtx = {}): void {
  try {
    rmSync(switchRequestPath(c), { force: true });
  } catch {
    /* best effort */
  }
}

export interface SwitchDecision {
  /** Account to switch the running session to, or null to stay put. */
  switchTo: string | null;
  /** Whether the request has been handled and should be cleared from disk. */
  consume: boolean;
}

/**
 * Decide what a running session should do with a pending request. Pure so the
 * lifecycle is fully testable:
 * - no request        -> do nothing, nothing to clear
 * - already on it      -> satisfied, clear it (so a later cap-rotation cannot be
 *                         yanked back by a stale same-account request)
 * - target unusable    -> cannot honor (logged out / unknown), clear it so it
 *                         does not linger
 * - otherwise          -> switch to it, clear it (fire once)
 */
export function decideSwitch(
  request: SwitchRequest | null,
  currentAccount: string,
  canUse: (account: string) => boolean,
): SwitchDecision {
  if (!request) return { switchTo: null, consume: false };
  if (request.account === currentAccount) return { switchTo: null, consume: true };
  if (!canUse(request.account)) return { switchTo: null, consume: true };
  return { switchTo: request.account, consume: true };
}
