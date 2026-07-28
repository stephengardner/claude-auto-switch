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
const SwitchRequestSchema = z.object({ account: z.string(), at: z.number() });
export type SwitchRequest = z.infer<typeof SwitchRequestSchema>;

const FILENAME = 'switch-request.json';

function switchRequestPath(c: PathCtx = {}): string {
  return path.join(configHome(c), FILENAME);
}

/** Ask a running session to switch to `account` and continue in place. */
export function writeSwitchRequest(account: string, at: number, c: PathCtx = {}): void {
  writeJsonFile(switchRequestPath(c), { account, at });
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
