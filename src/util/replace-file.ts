import { renameSync } from 'node:fs';

/**
 * Move a finished temp file over its target, the last step of an atomic write.
 *
 * On Windows a rename over a file another process has open fails (EPERM,
 * EACCES or EBUSY), and several ccx processes share the same state files by
 * design: every session, the dashboard and the status line all write the usage
 * snapshot and the active account. That refusal lasts as long as the other
 * process holds the file, usually a few milliseconds, so a write that gives up
 * at once loses an update another moment would have landed. One temp file was
 * left behind per lost write, 373 of them on one machine, two of which were
 * changes of the active account that never happened.
 *
 * So a refusal is retried briefly. Anything else, and a refusal that outlasts
 * the retries, is thrown for the caller, who removes the temp file.
 */

const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** Waits between attempts, in ms: about a fifth of a second in all. */
const BACKOFF_MS = [5, 10, 20, 40, 80];

function pause(ms: number): void {
  // Synchronous on purpose: every caller is a synchronous write, and making
  // them async to wait a few milliseconds would change every call site.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function replaceFileSync(
  temp: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
  rename: (from: string, to: string) => void = renameSync,
  wait: (ms: number) => void = pause,
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(temp, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      // POSIX replaces an open file without complaint, so a refusal there is a
      // real one, and waiting would only delay reporting it.
      const retry = platform === 'win32' && TRANSIENT.has(code) && attempt < BACKOFF_MS.length;
      if (!retry) throw error;
      wait(BACKOFF_MS[attempt] as number);
    }
  }
}
