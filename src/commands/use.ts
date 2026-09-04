import { getAccount } from '../accounts/registry.js';
import { setActive } from '../state/active.js';
import { writeSwitchRequest } from '../state/switch-request.js';
import { syncEditorPointerIfEnabled } from '../editor/junction.js';
import { liveLeases } from '../session/lease.js';
import { resolveTarget } from '../session/session-target.js';
import type { CliContext } from '../context.js';

export interface UseOptions {
  /** Instant switch by restarting the session (--continue) instead of the seamless swap. */
  now?: boolean;
  /** Target the session running in the current folder. */
  here?: boolean;
  /** Target a specific ccx-run pid (from `ccx sessions`). */
  session?: string;
}

/**
 * Set the active account. A live session moves to it (seamless, or --now
 * restart). With `--here` or `--session <pid>` the switch is aimed at ONE running
 * session, leaving the others on their own accounts; without either it broadcasts
 * to whichever session is running and sets the account new sessions start on.
 */
export function useCommand(context: CliContext, name: string, opts: UseOptions = {}): number {
  if (!getAccount(name, context.ctx)) {
    context.out(`account "${name}" not found`);
    return 1;
  }
  const mode = opts.now ? 'restart' : 'seamless';

  const targeted = opts.here || opts.session !== undefined;
  if (targeted) {
    let sessionPid: number | undefined;
    if (opts.session !== undefined) {
      sessionPid = Number(opts.session);
      if (!Number.isInteger(sessionPid) || sessionPid <= 0) {
        context.out(`--session must be a pid (a positive whole number), got "${opts.session}"`);
        return 1;
      }
    }
    const resolved = resolveTarget(liveLeases(context.ctx), {
      ...(sessionPid !== undefined ? { session: sessionPid } : {}),
      ...(opts.here ? { here: true, cwd: safeCwd() } : {}),
    });
    if (resolved.kind !== 'session') {
      // 'error' carries a message; 'broadcast' cannot occur for a targeted query
      // but is handled so the switch never silently falls back to every session.
      context.out(resolved.kind === 'error' ? resolved.message : 'could not identify a session to switch');
      return 1;
    }
    // A per-session switch deliberately does NOT touch the global active account
    // or the editor pointer: those follow the "default" session, and moving one
    // session's account must not drag every other surface with it.
    writeSwitchRequest(name, Date.now(), mode, context.ctx, resolved.pid);
    context.out(
      `asked session ${resolved.pid} (${resolved.lease.account}) to switch to ${name}` +
        (mode === 'seamless' ? ' (in place, within ~30s)' : ' now'),
    );
    return 0;
  }

  setActive(name, context.ctx);
  syncEditorPointerIfEnabled(context); // keep the editor in sync if it is on
  // Ask a running session to switch; seamless by default, instant restart with
  // --now. A no-op when nothing is running.
  writeSwitchRequest(name, Date.now(), mode, context.ctx);
  context.out(`active account: ${name}`);
  return 0;
}

function safeCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}
