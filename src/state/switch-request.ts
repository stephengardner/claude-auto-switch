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
 * - 'restart': end the process and relaunch, resuming this conversation, on the new
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
const PER_SESSION_DIR = 'switch-requests';

/**
 * Where a switch request lives.
 *
 * With no `pid` this is the ONE broadcast request that any running session will
 * honour: the historical behaviour of `ccx use`, kept so a switch with no
 * particular session in mind still reaches whichever session is running.
 *
 * With a `pid` it is that session's OWN request, under `switch-requests/<pid>`.
 * A session reads its own file FIRST, so `ccx use <account> --session <pid>` (or
 * `--here`) moves exactly one session while the others carry on untouched. The
 * pid is the ccx run's process id, which is also the name of its session
 * directory, so the two always agree on which session is which.
 */
function switchRequestPath(c: PathCtx = {}, pid?: number): string {
  return pid === undefined
    ? path.join(configHome(c), FILENAME)
    : path.join(configHome(c), PER_SESSION_DIR, `${pid}.json`);
}

/**
 * Ask a running session to switch to `account` (seamless by default). With a
 * `targetPid`, only the session with that pid honours it; without one, any
 * running session will.
 */
export function writeSwitchRequest(
  account: string,
  at: number,
  mode: SwitchMode = 'seamless',
  c: PathCtx = {},
  targetPid?: number,
): void {
  writeJsonFile(switchRequestPath(c, targetPid), { account, at, mode });
}

/**
 * The pending request for this session, or null. Pass the session's own `pid` to
 * read its per-session request; omit it for the broadcast one. A malformed file
 * is ignored (never crashes a live session).
 */
export function readSwitchRequest(c: PathCtx = {}, pid?: number): SwitchRequest | null {
  try {
    return readJsonFile(switchRequestPath(c, pid), SwitchRequestSchema) ?? null;
  } catch {
    return null;
  }
}

/** Remove the pending request (best effort). Pass `pid` to clear a per-session one. */
export function clearSwitchRequest(c: PathCtx = {}, pid?: number): void {
  try {
    rmSync(switchRequestPath(c, pid), { force: true });
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
