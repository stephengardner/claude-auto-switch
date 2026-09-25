import path from 'node:path';
import { liveLeases } from '../session/lease.js';
import { resolveTarget } from '../session/session-target.js';
import { isSessionDir, pidOfSessionDir, sessionDirFor } from '../session/session-dir.js';
import {
  clearResumePrompt,
  readResumePrompt,
  writeResumePrompt,
} from '../session/resume-prompt.js';
import type { CliContext } from '../context.js';

export interface ResumePromptOptions {
  /** Disarm instead of arming. */
  clear?: boolean;
  /** The session running in the current folder. */
  here?: boolean;
  /** A specific ccx-run pid (from `ccx sessions`). */
  session?: string;
}

/**
 * Arm, show, or disarm the prompt ONE running session is handed when ccx
 * relaunches it after an account swap (see src/session/resume-prompt.ts).
 *
 * `ccx resume-prompt <text...>` arms it, `--clear` disarms it, and with neither
 * it shows what is armed. The session is `--session <pid>`, else `--here`, else
 * the session this command runs INSIDE: a Claude session's tools run with that
 * session's own directory as `CLAUDE_CONFIG_DIR`, which is how an unattended
 * session arms itself without having to know its pid.
 */
export function resumePromptCommand(
  context: CliContext,
  words: string[],
  opts: ResumePromptOptions = {},
): number {
  const target = resolveSession(context, opts);
  if (!target.ok) {
    context.out(target.message);
    return 1;
  }
  const { pid } = target;
  const dir = sessionDirFor(pid, context.ctx);
  const text = words.join(' ');

  if (opts.clear) {
    if (text.trim() !== '') {
      context.out('give either a prompt or --clear, not both');
      return 1;
    }
    const had = clearResumePrompt(dir);
    context.out(had ? `disarmed session ${pid}` : `session ${pid} had nothing armed`);
    return 0;
  }

  if (text.trim() === '') {
    const read = readResumePrompt(dir);
    if (context.json) {
      context.out(
        JSON.stringify({
          pid,
          armed: read.armed,
          ...(read.armed ? { prompt: read.prompt } : {}),
          ...(!read.armed && read.invalid ? { invalid: read.invalid } : {}),
        }),
      );
    } else if (read.armed) {
      context.out(`session ${pid} is armed: ${read.prompt}`);
    } else if (read.invalid) {
      context.out(
        `session ${pid} has a prompt ccx will not use (${read.invalid}), so nothing is armed`,
      );
    } else {
      context.out(`session ${pid} has nothing armed`);
    }
    return 0;
  }

  const written = writeResumePrompt(dir, text);
  if (!written.ok) {
    context.out(`not armed: ${written.reason}`);
    return 1;
  }
  context.out(`armed session ${pid}: after a swap, ccx resumes it with: ${written.prompt}`);
  return 0;
}

type SessionTarget = { ok: true; pid: number } | { ok: false; message: string };

function resolveSession(context: CliContext, opts: ResumePromptOptions): SessionTarget {
  const leases = liveLeases(context.ctx);
  const env = context.ctx.env ?? process.env;

  if (opts.session !== undefined || opts.here) {
    let session: number | undefined;
    if (opts.session !== undefined) {
      session = Number(opts.session);
      if (!Number.isInteger(session) || session <= 0) {
        return {
          ok: false,
          message: `--session must be a pid (a positive whole number), got "${opts.session}"`,
        };
      }
    }
    const resolved = resolveTarget(leases, {
      ...(session !== undefined ? { session } : {}),
      ...(opts.here ? { here: true, cwd: safeCwd() } : {}),
    });
    if (resolved.kind === 'session') return { ok: true, pid: resolved.pid };
    return {
      ok: false,
      message: resolved.kind === 'error' ? resolved.message : 'could not identify a session',
    };
  }

  // The session this command runs inside: its config directory IS its session
  // directory. Anything else (a plain Claude, the pre-split shared directory)
  // cannot be named this way and must be named explicitly.
  const own = env.CLAUDE_CONFIG_DIR;
  if (own && isSessionDir(own, context.ctx)) {
    const pid = pidOfSessionDir(path.basename(path.resolve(own)));
    if (pid !== null) {
      if (leases.some((l) => l.pid === pid)) return { ok: true, pid };
      return {
        ok: false,
        message: `no live ccx session with pid ${pid} (this folder's session has ended)`,
      };
    }
  }
  return {
    ok: false,
    message:
      'not running inside a ccx session; name one with --session <pid> (see: ccx sessions) or --here',
  };
}

function safeCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}
